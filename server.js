// server.js
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { Storage } = require("@google-cloud/storage");
const speech = require("@google-cloud/speech").v1p1beta1;
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { execFile } = require("child_process");

const PORT = process.env.PORT || 8080;
const ORIGIN = process.env.ALLOW_ORIGIN || "*";
const DATA_DIR = process.env.DATA_DIR || "/tmp/data";
const GCS_BUCKET = process.env.GCS_BUCKET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
// const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET; // 未使用

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------- App / Middlewares ----------------
const app = express();
app.use(cors({ origin: ORIGIN, credentials: true }));
app.options("*", cors());
app.use(express.json());

const upload = multer({ dest: path.join(DATA_DIR, "chunks") });

// ---------------- GCP Clients ----------------
const storage = new Storage();
const bucket = storage.bucket(GCS_BUCKET);
const speechClient = new speech.SpeechClient();
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const { messagingApi } = require("@line/bot-sdk");
const lineClient = new messagingApi.MessagingApiClient({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
});

// ---------------- Utils ----------------
function execFFmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-y", ...args], { windowsHide: true }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(stderr || String(err)));
      resolve();
    });
  });
}

/**
 * sources を最大32個ずつ合成しながら最終的に 1 本のオブジェクトにまとめる。
 * - 可能なら File#compose() を使用
 * - 未対応環境では bucket.combine() にフォールバック
 * - 最後の 1 本 → 最終ファイル には compose せず copy() を使用
 */
async function composeMany(objects /* File[] */, destFile /* File */) {
  // compose を 1 回分行うヘルパー（fallback 付き）
  const composeOnce = async (sources /* File[] */, destination /* File */) => {
    if (typeof destination.compose === "function") {
      await destination.compose(sources);
    } else if (typeof destination.bucket.combine === "function") {
      // combine(sources, destination)
      await destination.bucket.combine(sources, destination);
    } else {
      throw new Error("Neither File.compose nor bucket.combine is available in this environment.");
    }
  };

  let queue = objects.slice();
  let round = 0;

  while (queue.length > 1) {
    const next = [];
    for (let i = 0; i < queue.length; i += 32) {
      const batch = queue.slice(i, i + 32);
      if (batch.length === 1) { next.push(batch[0]); continue; }

      const tmpName = `${destFile.name}.compose.${round}.${Math.floor(i / 32)}`;
      const tmp = destFile.bucket.file(tmpName);

      await composeOnce(batch, tmp);
      next.push(tmp);
    }
    queue = next;
    round++;
  }

  // 最後の 1 本を最終ファイル名へコピー（compose([single])は避ける）
  if (queue.length === 1 && queue[0].name !== destFile.name) {
    await queue[0].copy(destFile);
  }

  // 中間ファイルの掃除（存在しなければ無視）
  try { await destFile.bucket.deleteFiles({ prefix: `${destFile.name}.compose.` }); } catch {}
}

// ---------------- Routes ----------------

// 1) 署名URL発行（クライアントがPUTでチャンクを直アップロード）
app.post("/sign-upload", async (req, res) => {
  try {
    const { sessionId, userId, seq, contentType } = req.body || {};
    if (!sessionId || !userId || !seq) {
      return res.status(400).json({ ok: false, error: "sessionId/userId/seq required" });
    }
    const isMp4 = contentType && contentType.includes("mp4");
    const ext = isMp4 ? "mp4" : "webm";
    const objectPath = `sessions/${sessionId}/chunk-${String(seq).padStart(5, "0")}.${ext}`;
    const file = bucket.file(objectPath);

    const [signedUrl] = await file.getSignedUrl({
      version: "v4",
      action: "write",
      expires: Date.now() + 15 * 60 * 1000,
      contentType: contentType || (isMp4 ? "audio/mp4" : "audio/webm"),
    });

    res.json({ ok: true, signedUrl, objectPath });
  } catch (e) {
    console.error("[/sign-upload]", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// 2) 結合＋STTジョブ開始
app.post("/finalize", async (req, res) => {
  try {
    const { sessionId, userId } = req.body;
    if (!sessionId || !userId)
      return res.status(400).json({ ok: false, error: "sessionId/userId required" });

    // チャンク一覧
    const prefix = `sessions/${sessionId}/`;
    const [files] = await bucket.getFiles({ prefix });
    const chunks = files
      .filter((f) => /chunk-\d+\.(webm|mp4)$/.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (chunks.length === 0) return res.status(400).json({ ok: false, error: "no chunks in GCS" });

    // 1) まず GCS compose で一本化（fMP4/WebMに強い）
    const ext = chunks[0].name.endsWith(".mp4") ? "mp4" : "webm";
    const assembledObj = bucket.file(`sessions/${sessionId}/assembled.${ext}`);
    await composeMany(chunks.map((c) => bucket.file(c.name)), assembledObj);

    // 2) ffmpeg で一発WAV（16k/mono/LINEAR16）に変換
    const workDir = path.join(DATA_DIR, "sessions", sessionId);
    fs.mkdirSync(workDir, { recursive: true });
    const localAssembled = path.join(workDir, `assembled.${ext}`);
    const mergedWav = path.join(workDir, "merged.wav");

    await assembledObj.download({ destination: localAssembled });
    await execFFmpeg(["-i", localAssembled, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", mergedWav]);

    // 3) GCS へアップ（STT入力）
    const gcsName = `audio/${sessionId}.wav`;
    await bucket.upload(mergedWav, { destination: gcsName, contentType: "audio/wav" });
    const gcsUri = `gs://${GCS_BUCKET}/${gcsName}`;

    // 後片付け
    try {
      fs.unlinkSync(localAssembled);
    } catch {}
    try {
      fs.unlinkSync(mergedWav);
    } catch {}

    // 4) 非同期STT
    const [op] = await speechClient.longRunningRecognize({
      audio: { uri: gcsUri },
      config: {
        languageCode: "ja-JP",
        encoding: "LINEAR16",
        sampleRateHertz: 16000,
        enableAutomaticPunctuation: true,
        model: "latest_long",
      },
    });
    const jobId = op.name;

    // 5) /tmp にジョブメタ保存（MVP）
    const jobsDir = path.join(DATA_DIR, "jobs");
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.writeFileSync(
      path.join(jobsDir, `${jobId}.json`),
      JSON.stringify({ sessionId, userId, gcsUri }, null, 2)
    );

    res.json({ ok: true, jobId });
  } catch (e) {
    console.error("[/finalize] error", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// 3) ポーリング: /jobs/:id
app.get("/jobs/:id", async (req, res) => {
  try {
    const jobId = req.params.id;

    // ▼ SDK差異に両対応（配列でも単体でも）
    const progress = await speechClient.checkLongRunningRecognizeProgress(jobId);
    const op = Array.isArray(progress) ? progress[0] : progress;
    if (!op) {
      console.error("[/jobs] invalid operation object:", typeof progress, progress);
      return res.status(500).json({ ok: false, error: "invalid operation object" });
    }
    const isDone = op.done === true || (op.latestResponse && op.latestResponse.done === true);
    if (!isDone) {
      return res.json({ ok: true, status: "RUNNING" });
    }

    // ▼ 結果抽出も両対応
    let response;
    if (typeof op.promise === "function") {
      const result = await op.promise();
      response = Array.isArray(result) ? result[0] : result;
    } else if (op.result) {
      response = op.result;
    } else if (op.latestResponse && op.latestResponse.response) {
      response = op.latestResponse.response;
    } else {
      const p2 = await speechClient.checkLongRunningRecognizeProgress(jobId);
      const op2 = Array.isArray(p2) ? p2[0] : p2;
      if (op2 && op2.result) response = op2.result;
      else if (op2 && op2.latestResponse && op2.latestResponse.response)
        response = op2.latestResponse.response;
      else {
        console.error("[/jobs] cannot extract response from operation");
        return res.status(500).json({ ok: false, error: "cannot extract STT response" });
      }
    }

    const transcript = (response.results || [])
      .map((r) => r.alternatives?.[0]?.transcript || "")
      .join("\n")
      .trim();

    // メタ読込（sessionId / userId）
    const jobsDir = path.join(DATA_DIR, "jobs");
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(jobsDir, `${jobId}.json`), "utf-8"));
    } catch {}
    const sessionId = meta.sessionId || `unknown-${jobId}`;

    // ---- transcript を GCS 保存 ----
    try {
      await bucket.file(`transcripts/${sessionId}.txt`).save(transcript || "", {
        resumable: false,
        contentType: "text/plain; charset=utf-8",
        metadata: { cacheControl: "no-store" },
      });
    } catch (e) {
      console.error("save transcript failed:", e?.message);
    }

    // 短すぎるときは要約スキップ（ただしLINEで全文は送る）
    if (!transcript || transcript.replace(/\s/g, "").length < 15) {
      try {
        if (meta.userId) {
          await lineClient.pushMessage({
            to: meta.userId,
            messages: [
              { type: "text", text: "■診察メモ\n（短い録音のためメモは作成しませんでした）" },
              { type: "text", text: `＜文字起こし全文＞\n${(transcript || "").slice(0, 4000)}` },
            ],
          });
        }
      } catch (e) {
        console.error("LINE push (short) failed:", e?.statusCode, e?.message);
      }
      return res.json({
        ok: true,
        status: "DONE",
        transcript,
        summary: "（短い録音のためメモは作成しませんでした）",
      });
    }

    // ---- Gemini 要約（JSONのみで返す）----
const prompt = `
あなたは「患者さんに寄り添う診察メモ」を作る日本語の編集者です。
入力は【文字起こし】のみ。診断や断定はせず、事実ベースでやさしく整理してください。
医療に関係しない話題（仕事/学校/家事/支払い/連絡事項 等）が含まれても、
患者さんの生活に役立つ形で**必ず**要約・TODOに反映します。

【口調】
- 落ち着いた丁寧体（〜です／ます）。過剰敬語や前置きは不要。

【必須ルール】
- 出力は**JSONのみ**（コードブロック不可）。
- 不明な点は “不明” と明記。推測で断定しない。
- 専門語は「やさしい言い換え」を併記（例：炎症（体の守りが働いて腫れること））。
- 聞き違い/誤変換の疑いが高い語は、**修正候補**を別配列に列挙する（無理に作らない）。

【JSONスキーマ（厳守。既存キー＋拡張）】
{
  "summary": "5〜8行。医療と生活の両面。挨拶や前置きは書かない。",
  "summary_top3": ["要点を3行で。短文で。"],
  "decisions": ["決まったこと（方針/薬/検査/次回予定）。無ければ空配列。"],
  "todos_until_next": ["患者さんができる行動（時間帯や頻度を入れる）。医療/生活混在で最大7件。"],
  "ask_next_time": ["次回医師に聞くと良い具体質問（最大5件）。"],
  "red_flags": ["受診/連絡の目安（最大3件）。数値や時間など条件を含め簡潔に。"],
  "terms_plain": [ { "term":"", "easy":"", "note":"" } ],
  "maybe_corrections": [ { "heard":"", "likely":"", "reason":"" } ]
}

【作成ガイド】
- summary は**短文5〜8行**で、(1)今日わかったこと、(2)やること、(3)注意点 を含める。
- summary_top3 は最重要ポイントを3行で。
- terms_plain は、患者さんが難しいと感じそうな語（例：胃潰瘍、上部消化管内視鏡、逆流性食道炎、ピロリ菌、プロトンポンプ阻害薬 など）を優先。
- maybe_corrections は、明らかに聞き取り違いの可能性が高いものだけ（例：「プロポンプ阻害薬」→「プロトンポンプ阻害薬」）。

【文字起こし】
<<TRANSCRIPT>>
${transcript}
<</TRANSCRIPT>>
`.trim();

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
      generationConfig: { temperature: 0.3, topP: 0.8, topK: 40, maxOutputTokens: 1024 },
    });
    const gem = await model.generateContent(prompt);
    let raw = (gem.response && gem.response.text && gem.response.text()) || "";

    // コードブロックで返る場合に備える
    const jsonText = (() => {
      const m = raw.match(/```json([\s\S]*?)```/i);
      return (m ? m[1] : raw).trim();
    })();

    let j;
    try {
      j = JSON.parse(jsonText);
    } catch (e) {
      console.error("Gemini JSON parse failed:", e, "raw:", raw);
      j = {
        summary: transcript.split(/\n/).slice(0, 3).join("\n"),
        decisions: [],
        todos_until_next: [],
        ask_next_time: [],
        red_flags: [],
      };
    }
    const arr = (v) => (Array.isArray(v) ? v : []);
    j.decisions = arr(j.decisions);
    j.todos_until_next = arr(j.todos_until_next);
    j.ask_next_time = arr(j.ask_next_time);
    j.red_flags = arr(j.red_flags);
    j.summary = (j.summary || "").toString().trim();

    // ---- 要約を GCS 保存 ----
    try {
      await bucket.file(`summaries/${sessionId}.json`).save(JSON.stringify(j, null, 2), {
        resumable: false,
        contentType: "application/json",
        metadata: { cacheControl: "no-store" },
      });
    } catch (e) {
      console.error("save summary failed:", e?.message);
    }

    // ---- LINE 送信（1通目：要約 / 2通目：全文文字起こし）----
// ---- 整形（読みやすさ重視・セクション化）----
const arr = (v) => Array.isArray(v) ? v : [];
j.summary_top3 = arr(j.summary_top3);
j.terms_plain = arr(j.terms_plain);
j.maybe_corrections = arr(j.maybe_corrections);

const bullet = (a) => a.length ? a.map(x => `- ${x}`).join("\n") : "";
const bulletsKV = (a, fmt) => a.length ? a.map(fmt).join("\n") : "";

const header = "■診察メモ";
const top =
  (j.summary_top3.length
    ? `🧾 きょうの要点\n${bullet(j.summary_top3)}`
    : `🧾 きょうの要点\n${bullet(j.summary.split(/\n+/).slice(0,3))}`);

// 1通目セクション
const secDecisions = j.decisions.length ? `\n\n【決まったこと】\n${bullet(j.decisions)}` : "";
const secTodos     = j.todos_until_next.length ? `\n\n✅ あなたがやること\n${bullet(j.todos_until_next)}` : "";
const secAsk       = j.ask_next_time.length ? `\n\n❓ 次回ききたいこと\n${bullet(j.ask_next_time)}` : "";
const secFlags     = j.red_flags.length ? `\n\n🚩 こんな時は連絡/受診\n${bullet(j.red_flags)}` : "";
const secTerms = j.terms_plain.length
  ? `\n\n🔎 やさしい言い換え\n` + bulletsKV(j.terms_plain, t => `- ${t.term}：${t.easy}${t.note ? `（${t.note}）` : ""}`)
  : "";
const secCorrections = j.maybe_corrections.length
  ? `\n\n🛠️ ことばの修正候補\n` + bulletsKV(j.maybe_corrections, c => `- 「${c.heard}」→「${c.likely}」${c.reason ? `（理由：${c.reason}）` : ""}`)
  : "";

const cleaned = [
  header,
  top,
  secDecisions,
  secTodos,
  secFlags,      // 受診目安は上位に（重要度高）
  secTerms,
  secCorrections,
  secAsk
].filter(Boolean).join("\n");

// 2通目セクション
    try {
      if (meta.userId) {
        await lineClient.pushMessage({
          to: meta.userId,
          messages: [
            { type: "text", text: cleaned.slice(0, 4000) },
            { type: "text", text: `＜文字起こし全文＞\n${transcript.slice(0, 4000)}` },
          ],
        });
      }
    } catch (e) {
      console.error("LINE push failed:", e?.statusCode, e?.message);
    }

    return res.json({ ok: true, status: "DONE", transcript, summary: cleaned });
  } catch (e) {
    console.error("[/jobs] error", e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// 4) LINE Webhook（必要なら拡張）
app.post("/line/webhook", express.json(), async (req, res) => {
  res.status(200).end();
  try {
    const events = req.body.events || [];
    for (const ev of events) {
      if (ev.type === "follow") {
        await lineClient.replyMessage({
          replyToken: ev.replyToken,
          messages: [{ type: "text", text: "友だち追加ありがとうございます。LIFFから録音して送ってください。" }],
        });
      }
    }
  } catch (e) {
    console.error(e);
  }
});

// Healthz
const HOST = "0.0.0.0";
app.get("/", (_req, res) => res.json({ ok: true }));

app.listen(PORT, HOST, () => {
  console.log(`yorisoi mvp listening on ${HOST}:${PORT}`);
});
