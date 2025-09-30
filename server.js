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
const DETAIL_URL_TTL_DAYS = Number(process.env.DETAIL_URL_TTL_DAYS || "7"); // 署名URLの有効日数

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
  const composeOnce = async (sources /* File[] */, destination /* File */) => {
    if (typeof destination.compose === "function") {
      await destination.compose(sources);
    } else if (typeof destination.bucket.combine === "function") {
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

  if (queue.length === 1 && queue[0].name !== destFile.name) {
    await queue[0].copy(destFile);
  }

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
    try { fs.unlinkSync(localAssembled); } catch {}
    try { fs.unlinkSync(mergedWav); } catch {}

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
  const t0 = Date.now();
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

    // 短すぎるときは軽い通知のみ（1通）
    if (!transcript || transcript.replace(/\s/g, "").length < 15) {
      try {
        if (meta.userId) {
          await lineClient.pushMessage({
            to: meta.userId,
            messages: [{ type: "text", text: "■診察メモ\n（短い内容のためメモは作成しませんでした）" }],
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

    // ---- LLM（短い要約 / 詳細要約）を並列実行 ----
    const shortPrompt = `
あなたは「患者さんに寄り添う診察メモ」を作る日本語の編集者です。
入力は【文字起こし】のみ。診断や断定はせず、事実ベースでやさしく整理してください。
医療に関係しない話題（仕事/学校/家事/連絡など）も、患者さんの生活に役立つ形で要約・TODOに反映します。

【口調・方針】
- 落ち着いた丁寧体（〜です／ます）。前置きやAI的断り書きは不要。
- 会話の“引用”は禁止（「こんにちは」「横になってください」などは要点に入れない）。
- **誤変換・表記ゆれの“静かな正規化”**：専門用語や薬剤名などは一般的な正式名称に直して記述（例：プロポンプ阻害薬→プロトンポンプ阻害薬）。訂正リストは出さない。

【JSONのみで出力（コードブロック不可）】
{
  "summary_top3": ["最重要ポイント3行（各40字以内・引用不可）"],
  "decisions": ["決まったこと（方針/薬/検査/次回）。最大3件、各40字以内"],
  "todos_until_next": ["患者さんができる行動（いつ/どれくらい/理由）。最大5件、各40字以内"],
  "red_flags": ["受診/連絡の目安。2〜3件、各40字以内、数値や時間を入れる"],
  "ask_next_time": ["次回医師へ確認。最大3件、各40字以内"],
  "terms_plain": [ { "term":"", "easy":"" } ]  // 医療の専門用語や難語のやさしい言い換え。最大5件、easyは40字以内
}

【文字起こし】
<<TRANSCRIPT>>
${transcript}
<</TRANSCRIPT>>
`.trim();

    const detailPrompt = `
あなたは患者さんに寄り添う編集者です。以下の文字起こしから、詳しい診察メモをJSONで作成します。
会話の引用は避けて要約文で書き、誤変換や表記ゆれは**静かに一般的な正式名称へ正規化**してください。
（例：プロポンプ阻害薬→プロトンポンプ阻害薬、ヘリコバクター ピロリ→ヘリコバクター・ピロリ菌）

【JSONのみで出力（コードブロック不可）】
{
  "summary": "6〜12行の概要",
  "summary_top3": ["最重要ポイント3行"],
  "decisions": ["できるだけ網羅的に（方針/検査/薬/予約など）"],
  "todos_until_next": ["患者ができる行動。可能なら頻度・タイミング・理由も"],
  "ask_next_time": ["次回医師に確認したい具体的な質問"],
  "red_flags": ["受診/連絡の目安（数値・時間など条件を含める）"],
  "terms_plain": [{"term":"","easy":"","note":""}],
  "topic_blocks": [{"title":"", "bullets":[""]}],
  "timeline": [{"when":"", "what":"", "note":""}]
}

【文字起こし】
<<TRANSCRIPT>>
${transcript}
<</TRANSCRIPT>>
`.trim();

    const shortModel = genAI.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
      generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 1800, responseMimeType: "application/json" },
    });
    const detailModel = genAI.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
      generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 2800, responseMimeType: "application/json" },
    });

    const shortGen = shortModel.generateContent(shortPrompt);
    const detailGen = detailModel.generateContent(detailPrompt);

    const [shortResp, detailResp] = await Promise.all([shortGen, detailGen]);
    console.log(`[jobs] llm parallel ms=${Date.now()-t0}`);

    // ---- 短い要約のパース ----
    let j;
    try {
      const raw = shortResp.response.text();
      const m = raw.match(/```json([\s\S]*?)```/i);
      const jsonText = (m ? m[1] : raw).trim();
      j = JSON.parse(jsonText);
    } catch (e) {
      console.error("short JSON parse failed:", e?.message);
      j = { summary_top3: [], decisions: [], todos_until_next: [], ask_next_time: [], red_flags: [], terms_plain: [] };
    }
    const arr = (v) => (Array.isArray(v) ? v : []);
    j.summary_top3 = arr(j.summary_top3);
    j.decisions = arr(j.decisions);
    j.todos_until_next = arr(j.todos_until_next);
    j.ask_next_time = arr(j.ask_next_time);
    j.red_flags = arr(j.red_flags);
    j.terms_plain = arr(j.terms_plain);

    // ---- 詳細要約のパース ----
    let full = {};
    try {
      const dText = detailResp.response.text();
      const dm = dText.match(/\{[\s\S]*\}$/);
      full = JSON.parse(dm ? dm[0] : dText);
    } catch (e) {
      console.error("detail JSON parse failed:", e?.message);
      full = { summary: "", summary_top3: j.summary_top3, decisions: j.decisions, todos_until_next: j.todos_until_next, ask_next_time: j.ask_next_time, red_flags: j.red_flags, terms_plain: j.terms_plain, topic_blocks: [], timeline: [] };
    }

    // ---- GCS保存（短いJSON / 詳しいJSON / HTML）を並列 ----
    const htmlStr = buildDetailHtml(full, transcript);
    const htmlFile = bucket.file(`summaries/${sessionId}.html`);
    await Promise.all([
      bucket.file(`summaries/${sessionId}.json`).save(JSON.stringify(j, null, 2), { resumable:false, contentType:"application/json", metadata:{ cacheControl:"no-store" } }),
      bucket.file(`summaries/${sessionId}.full.json`).save(JSON.stringify(full, null, 2), { resumable:false, contentType:"application/json", metadata:{ cacheControl:"no-store" } }),
      htmlFile.save(htmlStr, { resumable:false, contentType:"text/html; charset=utf-8", metadata:{ cacheControl:"no-store" } }),
    ]);

    const [detailUrl] = await htmlFile.getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + DETAIL_URL_TTL_DAYS*24*60*60*1000
    });

    // ---- LINE整形（短く見やすく）----
    const cap = (a, n) => arr(a).slice(0, n);
    const short = (s, n=40) => (s||"").length>n ? (s.slice(0,n-1)+"…") : (s||"");
    j.summary_top3     = cap(j.summary_top3, 3).map(x => short(x, 40));
    j.decisions        = cap(j.decisions, 3).map(x => short(x, 40));
    j.todos_until_next = cap(j.todos_until_next, 5).map(x => short(x, 40));
    const rf = cap(j.red_flags, 3).map(x => short(x, 40));
    j.red_flags = rf.length >= 2 ? rf : rf;
    j.ask_next_time    = cap(j.ask_next_time, 3).map(x => short(x, 40));
    j.terms_plain      = cap(j.terms_plain, 3).map(t => ({ term: short(t.term, 24), easy: short(t.easy, 40) }));

    const bullet = (a) => a.length ? a.map(x => `・ ${x}`).join("\n") : "";
    const bulletsKV = (a, fmt) => a.length ? a.map(fmt).join("\n") : "";

    const header = "■診察メモ";
    const top =
      (j.summary_top3.length
        ? `🧾 きょうの要点\n${bullet(j.summary_top3)}`
        : `🧾 きょうの要点\n${bullet([].slice.call((j.summary||"").split(/\n+/),0,3))}`);

    const secDecisions = j.decisions.length ? `\n\n【決まったこと】\n${bullet(j.decisions)}` : "";
    const secTodos     = j.todos_until_next.length ? `\n\n✅ あなたがやること\n${bullet(j.todos_until_next)}` : "";
    const secAsk       = j.ask_next_time.length ? `\n\n❓ 次回ききたいこと\n${bullet(j.ask_next_time)}` : "";
    const secFlags     = j.red_flags.length ? `\n\n🚩 こんな時は連絡/受診\n${bullet(j.red_flags)}` : "";
    const secTerms     = j.terms_plain.length
      ? `\n\n🔎 やさしい言い換え\n` + bulletsKV(j.terms_plain, t => `・ ${t.term}：${t.easy}`)
      : "";

    let cleaned = [
      header,
      top,
      secDecisions,
      secTodos,
      secFlags,
      secTerms,
      secAsk
    ].filter(Boolean).join("\n");

    cleaned += `\n\n🔗 詳細を見る（${DETAIL_URL_TTL_DAYS}日有効）\n${detailUrl}`;

    // ---- 冪等化（重複送信防止）：GCSマーカーを ifGenerationMatch:0 で作成 ----
    const deliveryMarker = bucket.file(`deliveries/${jobId}.done`);
    let acquired = false;
    try {
      await deliveryMarker.save(
        JSON.stringify({ pushedAt: new Date().toISOString(), sessionId, detailUrl }, null, 2),
        {
          resumable: false,
          contentType: "application/json",
          ifGenerationMatch: 0, // 既存なら412
        }
      );
      acquired = true;
    } catch (e) {
      if (e.code === 412) {
        // 既に他インスタンスが送信済み
        return res.json({ ok: true, status: "DONE", transcript });
      }
      throw e;
    }

    // ---- LINE送信（1通のみ）----
    if (acquired && meta.userId) {
      try {
        await lineClient.pushMessage({
          to: meta.userId,
          messages: [{ type: "text", text: cleaned.slice(0, 4999) }],
        });
      } catch (e) {
        console.error("LINE push failed:", e?.statusCode, e?.message);
      }
    }

    console.log(`[jobs] total ms=${Date.now()-t0}`);
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

// ---------------- Helpers for Detail HTML ----------------
function escapeHtml(s="") {
  return (s || "").replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
}

function buildDetailHtml(full, transcript) {
  const li = (t) => t ? `<li>${escapeHtml(t)}</li>` : "";
  const ul = (arr) => (arr && arr.length) ? `<ul>${arr.map(li).join("")}</ul>` : "";
  const term = (t) => t ? `<li><b>${escapeHtml(t.term)}</b>：${escapeHtml(t.easy || "")}${t.note?`（${escapeHtml(t.note)}）`:""}</li>` : "";

  const blocks = (full.topic_blocks || []).map(b =>
    `<h2>${escapeHtml(b.title || "")}</h2>${ul(b.bullets || [])}`).join("");

  const timeline = (full.timeline || []).map(t =>
    `・${escapeHtml(t.when || "")}：${escapeHtml(t.what || "")}${t.note?`（${escapeHtml(t.note)}）`:""}`).join("<br>");

  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>診察メモ（詳細）</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN","Yu Gothic",Meiryo,sans-serif;margin:16px;line-height:1.72}
  h1{font-size:20px;margin:8px 0 12px}
  h2{font-size:16px;margin:22px 0 8px;border-left:4px solid #4a7;padding-left:8px}
  ul{margin:6px 0 12px 1.2em;padding:0}
  li{margin:4px 0}
  .box{background:#fafafa;border:1px solid #eee;border-radius:8px;padding:12px}
  .muted{color:#666;font-size:12px;margin-top:16px}
  pre{white-space:pre-wrap;background:#fbfbfb;border:1px solid #eee;border-radius:8px;padding:12px}
  .pill{display:inline-block;background:#eef7f0;color:#274;font-weight:600;padding:2px 8px;border-radius:999px;font-size:12px}
</style></head>
<body>
  <h1>診察メモ（詳細）</h1>

  <div class="box">
    <span class="pill">きょうの要点</span>
    ${ul(full.summary_top3 || [])}
  </div>

  ${ (full.summary && full.summary.trim()) ? `<h2>概要</h2><div>${escapeHtml(full.summary)}</div>` : "" }
  ${ (full.decisions?.length) ? `<h2>決まったこと</h2>${ul(full.decisions)}` : "" }
  ${ (full.todos_until_next?.length) ? `<h2>あなたがやること</h2>${ul(full.todos_until_next)}` : "" }
  ${ (full.red_flags?.length) ? `<h2>こんな時は連絡/受診</h2>${ul(full.red_flags)}` : "" }
  ${ (full.ask_next_time?.length) ? `<h2>次回ききたいこと</h2>${ul(full.ask_next_time)}` : "" }
  ${ (full.terms_plain?.length) ? `<h2>やさしい言い換え</h2><ul>${(full.terms_plain||[]).map(term).join("")}</ul>` : "" }

  ${ blocks || "" }
  ${ (full.timeline?.length) ? `<h2>予定表</h2><div>${timeline}</div>` : "" }

  <h2>文字起こし（全文）</h2>
  <pre>${escapeHtml(transcript || "")}</pre>

  <p class="muted">※このメモは診断ではありません。変化や不安がある時は医療者へ相談してください。</p>
</body></html>`;
}
