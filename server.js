// server.js (yorisoi MVP – chunked summarization + storage)
// Node 18+ / Cloud Run (asia-northeast1)
//
// 必要な環境変数：
// - ALLOW_ORIGIN, GCS_BUCKET, GEMINI_API_KEY
// - LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET (必要に応じて)
// - DATA_DIR（任意, デフォルト /tmp/data）

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
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

if (!GCS_BUCKET) throw new Error("GCS_BUCKET is required");
if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is required");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// --- App / CORS ---
const app = express();
app.use(cors({ origin: ORIGIN, credentials: true }));
app.options("*", cors());
app.use(express.json());

const upload = multer({ dest: path.join(DATA_DIR, "chunks") });

// --- GCP clients ---
const storage = new Storage();
const bucket = storage.bucket(GCS_BUCKET);
const speechClient = new speech.SpeechClient();
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
// LINE client（必要なら）
const { messagingApi } = require("@line/bot-sdk");
const lineClient = (LINE_CHANNEL_ACCESS_TOKEN
  ? new messagingApi.MessagingApiClient({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN })
  : null);

// ========== 1) 署名URL発行：/sign-upload ==========
app.post("/sign-upload", async (req, res) => {
  try {
    const { sessionId, userId, seq, contentType } = req.body || {};
    if (!sessionId || !userId || !seq) {
      return res.status(400).json({ ok: false, error: "sessionId/userId/seq required" });
    }
    const ext = (contentType && contentType.includes("mp4")) ? "mp4" : "webm";
    const objectPath = `sessions/${sessionId}/chunk-${String(seq).padStart(5, "0")}.${ext}`;
    const file = bucket.file(objectPath);

    const [signedUrl] = await file.getSignedUrl({
      version: "v4",
      action: "write",
      expires: Date.now() + 60 * 1000, // TTL短め（濫用抑止）
      contentType: contentType || "application/octet-stream",
    });

    res.json({ ok: true, signedUrl, objectPath });
  } catch (e) {
    console.error("[/sign-upload]", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ========== 2) 結合→WAV→STTジョブ：/finalize ==========
app.post("/finalize", async (req, res) => {
  try {
    const { sessionId, userId } = req.body || {};
    if (!sessionId || !userId) return res.status(400).json({ ok: false, error: "sessionId/userId required" });

    // 1) GCS: チャンク一覧
    const prefix = `sessions/${sessionId}/`;
    const [files] = await bucket.getFiles({ prefix });
    const chunks = files
      .filter(f => /chunk-\d+\.(webm|mp4)$/.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (chunks.length === 0) return res.status(400).json({ ok: false, error: "no chunks in GCS" });

    // 2) /tmp へDL → 個別WAV(16k/mono) 変換
    const workDir = path.join(DATA_DIR, "sessions", sessionId);
    const wavsDir = path.join(workDir, "wavs");
    fs.mkdirSync(wavsDir, { recursive: true });

    const wavPaths = [];
    for (const f of chunks) {
      const localSrc = path.join(workDir, path.basename(f.name));
      await f.download({ destination: localSrc });
      const out = path.join(wavsDir, path.basename(localSrc).replace(/\.(webm|mp4)$/, ".wav"));
      try {
        await execFFmpeg(["-i", localSrc, "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", out]);
        wavPaths.push(out);
      } catch (e) {
        console.warn("ffmpeg failed for", f.name, e?.message);
      } finally {
        try { fs.unlinkSync(localSrc); } catch {}
      }
    }
    if (wavPaths.length === 0) return res.status(400).json({ ok: false, error: "all chunks invalid" });

    // 3) 安定結合（concat demuxer + 再エンコード + 軽整音）
    const list = path.join(workDir, "wav-list.txt");
    fs.writeFileSync(list, wavPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));

    const merged = path.join(workDir, "merged.wav");
    const af = `loudnorm=I=-23:TP=-2:LRA=7,silenceremove=start_periods=1:start_duration=0.5:start_threshold=-45dB`;
    await execFFmpeg([
      "-f", "concat", "-safe", "0", "-i", list,
      "-vn", "-af", af,
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
      merged
    ]);

    // 4) GCSへアップ
    const gcsName = `audio/${sessionId}.wav`;
    await bucket.upload(merged, { destination: gcsName, contentType: "audio/wav" });
    const gcsUri = `gs://${GCS_BUCKET}/${gcsName}`;

    // 後片付け
    try { fs.unlinkSync(list); } catch {}
    try { fs.unlinkSync(merged); } catch {}
    for (const p of wavPaths) { try { fs.unlinkSync(p); } catch {} }

    // 5) LongRunning STT
    const [op] = await speechClient.longRunningRecognize({
      audio: { uri: gcsUri },
      config: {
        languageCode: "ja-JP",
        encoding: "LINEAR16",
        sampleRateHertz: 16000,
        enableAutomaticPunctuation: true,
        enableSpokenPunctuation: true, // 利用可の環境では句読点補助
        model: "latest_long"
      },
    });
    const jobId = op.name;

    // 6) jobメタ保存 (/tmp → 将来はFirestore推奨)
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

// ========== 3) 進捗→要約（分割→統合）: /jobs/:id ==========
app.get("/jobs/:id", async (req, res) => {
  try {
    const jobId = req.params.id;

    // 1) 進捗
    const operation = await speechClient.checkLongRunningRecognizeProgress(jobId);
    if (!operation.done) return res.json({ ok: true, status: "RUNNING" });

    // 2) 結果
    const [response] = await operation.promise();
    const transcript = (response.results || [])
      .map(r => r.alternatives?.[0]?.transcript || "")
      .join("\n")
      .trim();

    // 3) 短すぎる場合の保護
    if (!transcript || transcript.replace(/\s/g, "").length < 15) {
      return res.json({ ok: true, status: "DONE", transcript, summary: "（短い録音のためメモは作成しませんでした）" });
    }

    // 4) 分割→各チャンク要約→総合要約（Gemini 2.5 Flash-Lite）
    const mode = detectMode(transcript);
    const parts = splitTranscript(transcript, 1800); // 1,800文字目安
    const partials = [];
    for (const part of parts) {
      const prompt = buildPrompt(mode, part);
      try {
        const j = await geminiJson(genAI, "gemini-2.5-flash-lite", prompt, 2200);
        partials.push(j);
      } catch (e) {
        console.error("chunk summarize failed", e?.message);
      }
    }
    if (partials.length === 0) {
      partials.push({ summary: transcript.slice(0, 400), actions: [], medical: {}, lifestyle: [], red_flags: [], next_questions: [] });
    }

    const reducePrompt = buildReducePrompt(mode, partials);
    const reduced = await geminiJson(genAI, "gemini-2.5-flash-lite", reducePrompt, 2800);

    // 5) LINE用整形（短いカード＋詳細分割（必要時））
    const shortMsg = formatShortCard(reduced, mode);
    const { detailChunks, detailBody } = formatDetails(reduced, mode);

    // 6) STT/要約のGCS保存
    const jobsDir = path.join(DATA_DIR, "jobs");
    const meta = JSON.parse(fs.readFileSync(path.join(jobsDir, `${jobId}.json`), "utf-8"));

    const tsName = `transcripts/${meta.sessionId}.txt`;
    const tsJson = `transcripts/${meta.sessionId}.json`;
    const sumJson = `summaries/${meta.sessionId}.json`;
    const sumTxt = `summaries/${meta.sessionId}.txt`;

    await bucket.file(tsName).save(transcript, { contentType: "text/plain" });
    await bucket.file(tsJson).save(JSON.stringify({ transcript, jobId, gcsUri: meta.gcsUri }, null, 2), { contentType: "application/json" });
    await bucket.file(sumJson).save(JSON.stringify(reduced, null, 2), { contentType: "application/json" });
    await bucket.file(sumTxt).save([shortMsg, ...(detailBody ? ["\n---\n", detailBody] : [])].join("\n"), { contentType: "text/plain" });

    // 7) LINE Push（有効時）
    if (lineClient) {
      try {
        await lineClient.pushMessage({ to: meta.userId, messages: [{ type: "text", text: shortMsg.slice(0, 4999) }] });
        for (const part of detailChunks) {
          await lineClient.pushMessage({ to: meta.userId, messages: [{ type: "text", text: part.slice(0, 4999) }] });
        }
      } catch (e) {
        console.error("LINE push failed:", e?.statusCode, e?.message);
      }
    }

    return res.json({ ok: true, status: "DONE", transcript, summary: shortMsg });
  } catch (e) {
    console.error("[/jobs] error", e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// ========== 4) LINE Webhook ==========
app.post("/line/webhook", express.json(), async (req, res) => {
  res.status(200).end(); // 先にOK
  if (!lineClient) return;
  try {
    const events = req.body.events || [];
    for (const ev of events) {
      if (ev.type === "follow") {
        await lineClient.replyMessage({
          replyToken: ev.replyToken,
          messages: [{ type: "text", text: "友だち追加ありがとうございます。LIFFから録音して送ってください。" }]
        });
      }
    }
  } catch (e) {
    console.error("webhook error", e);
  }
});

// ========== 5) ヘルスチェック ==========
app.get("/", (_, res) => res.json({ ok: true }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`yorisoi mvp listening on 0.0.0.0:${PORT}`);
});

// ======================================================================
//                               Helpers
// ======================================================================

function execFFmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-y", ...args], { windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || String(err)));
      resolve();
    });
  });
}

function splitTranscript(text, chunkChars = 1800) {
  const normalized = (text || "").replace(/\r/g, "");
  const parts = [];
  let i = 0;
  while (i < normalized.length) {
    let end = Math.min(i + chunkChars, normalized.length);
    // 句点付近で切る（読みやすさ & 内容保持）
    const cut = normalized.lastIndexOf("。", end + 100);
    if (cut > end - 200) end = cut + 1;
    parts.push(normalized.slice(i, end).trim());
    i = end;
  }
  return parts.filter(Boolean);
}

function detectMode(t) {
  const text = t || "";
  const isSurgery = /(手術|術前|術後|麻酔|合併症|入院|同意|縫合|ドレーン|内視鏡)/.test(text);
  const medTerms = (text.match(/(処方|mg|投与|検査|採血|画像|CT|MRI|レントゲン|結果|診断)/g) || []).length;
  const hasPlan = /(方針|次回|再診|予約|計画)/.test(text);
  const isLowInfo = text.length < 800 || (medTerms + (hasPlan ? 1 : 0)) < 2;
  if (isSurgery) return "surgery";
  if (isLowInfo) return "bridge";
  return "normal";
}

function buildPrompt(mode, transcriptChunk) {
  const head =
    mode === "surgery" ? "（手術説明モード）方法/リスク/準備/流れを落とさない。" :
    mode === "bridge"  ? "（寄り添いモード）言語化の問い・記録ポイントも示す。" :
                         "（通常モード）患者向けの要点・やること重視。";

  const commonRule = `
出力は必ずJSONのみ（コードブロック不可）。推測で断定しない。医療に関係ない話題も"lifestyle"として短く残す。
最低限のキー: { "summary": "", "actions": [], "medical": { "terms": [], "meds": [], "tests": [] }, "lifestyle": [], "red_flags": [], "next_questions": [] }
- summary: 3-6行（このチャンク内の要点）
- actions: 患者ができる行動（最大5, 具体的に）
- medical.terms: [{"term":"","easy":"","note":""}]
- medical.meds: [{"name":"","dose":"","timing":"","duration":"","purpose":""}]
- medical.tests: [{"name":"","status":"","when":"","purpose":""}]
- lifestyle: 医療外の気づき（仕事/家事/学校/支払い/連絡事項 等）最大5
- red_flags: 一般的受診目安（必要に応じて）
- next_questions: 次回聞くと良い具体質問（最大5）
JSONのみ出力。
  `.trim();

  return `${head}\n${commonRule}\n<<TRANSCRIPT>>\n${transcriptChunk}\n<</TRANSCRIPT>>`;
}

function buildReducePrompt(mode, partials) {
  return `
あなたは患者さん向けの編集者です。複数の部分要約(JSON配列)を統合し、以下スキーマで出力してください。
医療外の話題も"lifestyle"に残し、手術モードなら二層構成で情報を落とさない。

スキーマ:
{
 "mode": "normal|bridge|surgery",
 "short_card": {
   "greeting": "",
   "summary_top3": [""],
   "actions_top3": [""],
   "red_flags_top3": [""]
 },
 "detailed": {
   "topic_blocks": [{"title":"", "bullets":[""]}],
   "timeline": [{"when":"", "what":"", "note":""}],
   "do_not_omit": [""],
   "lifestyle": [""],
   "safety_footer": "このメモは診断ではなく…変化や不安がある時は医療者へ相談してください。"
 }
}
制約：
- short_card 各配列は最大3件。
- mode="${mode}" を反映。mode="surgery" のとき topic_blocks を複数作成し、数値/期間/確率を省略しない。mode!="surgery" でも detailed.lifestyle を残す。
- JSONのみで出力。

<<PARTIALS>>
${JSON.stringify(partials).slice(0, 400000)}
<</PARTIALS>>
`.trim();
}

async function geminiJson(genAI, modelName, prompt, maxTokens = 1800) {
  const model = genAI.getGenerativeModel({
    model: modelName, // e.g. gemini-2.5-flash-lite
    generationConfig: {
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: maxTokens,
      responseMimeType: "application/json"
    }
  });
  const resp = await model.generateContent(prompt);
  const text = resp.response.text();
  const m = text.match(/\{[\s\S]*\}$/);
  const raw = m ? m[0] : text;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error("JSON parse failed", e?.message);
    return { summary: "", actions: [], medical: { terms: [], meds: [], tests: [] }, lifestyle: [], red_flags: [], next_questions: [] };
  }
}

function safeJoinLines(arr) {
  return (arr || []).filter(Boolean).map(x => `- ${x}`).join("\n");
}

function formatShortCard(reduced, mode) {
  return [
    mode === "surgery" ? "■診察メモ（手術のご説明）" : "■診察メモ",
    `🕊️ ${reduced.short_card?.greeting || "受診おつかれさまでした。"}`,
    (reduced.short_card?.summary_top3?.length ? "🧾 きょうの要点\n" + safeJoinLines(reduced.short_card.summary_top3) : ""),
    (reduced.short_card?.actions_top3?.length ? "✅ あなたがやること\n" + safeJoinLines(reduced.short_card.actions_top3) : ""),
    (reduced.short_card?.red_flags_top3?.length ? "🚩 こんな時は連絡/受診\n" + safeJoinLines(reduced.short_card.red_flags_top3) : "")
  ].filter(Boolean).join("\n");
}

function formatDetails(reduced, mode) {
  const blocks = (reduced.detailed?.topic_blocks || [])
    .map(b => `\n【${b.title}】\n${safeJoinLines(b.bullets)}`)
    .join("");
  const lifestyle = reduced.detailed?.lifestyle?.length ? `\n🏠 生活メモ\n${safeJoinLines(reduced.detailed.lifestyle)}` : "";
  const timeline = (reduced.detailed?.timeline || [])
    .map(t => `- ${t.when}：${t.what}${t.note ? "（" + t.note + "）" : ""}`).join("\n");
  const footer = `\nⓘ ${reduced.detailed?.safety_footer || "このメモは診断ではありません。変化や不安がある時は医療者へ相談してください。"}`;

  let detailBody = "";
  if (mode === "surgery") {
    detailBody = ["🔎 くわしい内容", blocks, lifestyle, (timeline ? `\n【予定表】\n${timeline}` : ""), footer]
      .filter(Boolean).join("\n");
  } else {
    detailBody = ["🔎 詳細", blocks || "", lifestyle || "", footer]
      .filter(Boolean).join("\n");
  }

  const detailChunks = [];
  for (let i = 0; i < detailBody.length; i += 4200) {
    detailChunks.push(detailBody.slice(i, i + 4200));
  }
  return { detailChunks, detailBody };
}
