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
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// CORS
const app = express();
app.use(cors({ origin: ORIGIN, credentials: true }));
app.options('*', cors());
app.use(express.json());

const upload = multer({ dest: path.join(DATA_DIR, "chunks") });

// GCP clients
const storage = new Storage();
const bucket = storage.bucket(GCS_BUCKET);
const speechClient = new speech.SpeechClient();
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const { messagingApi } = require("@line/bot-sdk");
const lineClient = new messagingApi.MessagingApiClient({
channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
});

// 1) チャンクアップロード
  // POST /sign-upload  { sessionId, userId, seq, contentType }
app.post("/sign-upload", async (req, res) => {
  try {
    const { sessionId, userId, seq, contentType } = req.body || {};
    if (!sessionId || !userId || !seq) {
      return res.status(400).json({ ok:false, error:"sessionId/userId/seq required" });
    }
    const ext = (contentType && contentType.includes("mp4")) ? "mp4" : "webm";
    const objectPath = `sessions/${sessionId}/chunk-${String(seq).padStart(5,"0")}.${ext}`;
    const file = bucket.file(objectPath);

    // V4 Signed URL（PUT）
    const [signedUrl] = await file.getSignedUrl({
      version: "v4",
      action:  "write",
      expires: Date.now() + 15 * 60 * 1000,
      contentType: contentType || "application/octet-stream",
    });

    res.json({ ok:true, signedUrl, objectPath });
  } catch (e) {
    console.error("[/sign-upload]", e);
    res.status(500).json({ ok:false, error:String(e) });
  }
});


// 2) 結合＋STTジョブ開始: /finalize
app.post("/finalize", async (req, res) => {
  try {
    const { sessionId, userId } = req.body;
    if (!sessionId || !userId) return res.status(400).json({ ok:false, error:"sessionId/userId required" });

    // 1) GCSからチャンク一覧
    const prefix = `sessions/${sessionId}/`;
    const [files] = await bucket.getFiles({ prefix });
    const chunks = files
      .filter(f => /chunk-\d+\.(webm|mp4)$/.test(f.name))
      .sort((a,b)=> a.name.localeCompare(b.name));
    if (chunks.length === 0) return res.status(400).json({ ok:false, error:"no chunks in GCS" });

    // 2) /tmpへDL → 個別WAV化（16k/mono）
    const workDir = path.join(DATA_DIR, "sessions", sessionId);
    const wavsDir = path.join(workDir, "wavs");
    fs.mkdirSync(wavsDir, { recursive: true });

    const wavPaths = [];
    for (const f of chunks) {
      const localSrc = path.join(workDir, path.basename(f.name));
      await f.download({ destination: localSrc });
      const out = path.join(wavsDir, path.basename(localSrc).replace(/\.(webm|mp4)$/,".wav"));
      await execFFmpeg(["-i", localSrc, "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", out]);
      wavPaths.push(out);
    try { fs.unlinkSync(localSrc); } catch {}
}

    // 3) WAVを無劣化連結（ffconcat + -c copy）
    const list = path.join(workDir, "wav-list.ffconcat");
    fs.writeFileSync(list, ["ffconcat version 1.0", ...wavPaths.map(p => `file '${p.replace(/'/g,"'\\''")}'`)].join("\n"));
    const merged = path.join(workDir, "merged.wav");
    await execFFmpeg(["-f","concat","-safe","0","-i", list, "-c","copy", merged]);

    // 4) 1本にしたWAVをGCSへ再アップ
    const gcsName = `audio/${sessionId}.wav`;
    await bucket.upload(merged, { destination: gcsName, contentType:"audio/wav" });
    const gcsUri = `gs://${GCS_BUCKET}/${gcsName}`;
    for (const p of wavPaths) { try { fs.unlinkSync(p); } catch {} }
    try { fs.unlinkSync(list); } catch {}
    try { fs.unlinkSync(merged); } catch {}

    // 5) 非同期STT（既存のまま）
    const [op] = await speechClient.longRunningRecognize({
      audio: { uri: gcsUri },
      config: { languageCode:"ja-JP", encoding:"LINEAR16", sampleRateHertz:16000, enableAutomaticPunctuation:true, model:"latest_long" },
    });
    const jobId = op.name;

    // 6) jobメタ保存（MVPなら /tmp で可。将来はGCS/Firestore推奨）
    const jobsDir = path.join(DATA_DIR, "jobs");
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.writeFileSync(path.join(jobsDir, `${jobId}.json`), JSON.stringify({ sessionId, userId, gcsUri }, null, 2));

    res.json({ ok:true, jobId });
  } catch (e) {
    console.error("[/finalize] error", e);
    res.status(500).json({ ok:false, error:String(e) });
  }
});


// 3) ポーリング: /jobs/:id
  app.get("/jobs/:id", async (req, res) => {
    try {
      const jobId = req.params.id;

    // 進捗取得（返り値は [operation] の配列）
    const [operation] = await speechClient.checkLongRunningRecognizeProgress(jobId);
    if (!operation.done) {
      return res.json({ ok: true, status: "RUNNING" });
    }
    // 完了 → 結果（promise() で [response] ）
    const [response] = await operation.promise();
    const transcript = (response.results || [])
      .map(r => r.alternatives?.[0]?.transcript || "")
      .join("\n")
      .trim();

    // 内容が短すぎる場合はスキップ（誤検知の護身）
    if (!transcript || transcript.replace(/\s/g, "").length < 15) {
      return res.json({ ok: true, status: "DONE", transcript, summary: "（短い録音のためメモは作成しませんでした）" });
    }

    // ---- Gemini で要約：JSONのみ、AI前置き禁止、付き添い者視点 ----
    const prompt = `
あなたは「患者さんの付き添い者が後で見返すための診察メモ」を作る編集者です。
以下の【文字起こし】だけを根拠に、AI的な前置きや敬語過多は入れず、事実ベースで簡潔にまとめてください。
憶測や診断は書かないでください。出力は必ず JSON のみ。

# 出力要件
- 口調：落ち着いた丁寧体（〜です／ます）。過剰敬語は避ける。
- 視点：付き添い者（患者が何を理解・決定・未解決かが分かる）。
- 優先：不安／決まったこと／次回までの約束／注意サイン。
- 1行40文字目安。簡潔に。

# JSON 形式
{
  "summary": "3〜5行。AI前置き禁止。",
  "decisions": ["決まったこと。無ければ空配列"],
  "todos_until_next": ["次回までのTODO。無ければ空配列"],
  "ask_next_time": ["次回医師に確認したいこと。無ければ空配列"],
  "red_flags": ["注意サイン。無ければ空配列"]
}

【文字起こし】
${transcript}
`.trim();

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
      generationConfig: { temperature: 0.3, topP: 0.8, topK: 40, maxOutputTokens: 1024 },
    });
    const gem = await model.generateContent(prompt);
    let raw = (gem.response && gem.response.text && gem.response.text()) || "";

    // コードブロック（```json ...```）で返る対策
    const jsonText = (() => {
      const m = raw.match(/```json([\s\S]*?)```/i);
      return (m ? m[1] : raw).trim();
    })();

    // JSONを安全にパース＋型補正
    let j;
    try { j = JSON.parse(jsonText); } catch (e) {
      console.error("Gemini JSON parse failed:", e, "raw:", raw);
      j = { summary: transcript.split(/\n/).slice(0,3).join("\n"), decisions: [], todos_until_next: [], ask_next_time: [], red_flags: [] };
    }
    const arr = v => Array.isArray(v) ? v : [];
    j.decisions = arr(j.decisions);
    j.todos_until_next = arr(j.todos_until_next);
    j.ask_next_time = arr(j.ask_next_time);
    j.red_flags = arr(j.red_flags);
    j.summary = (j.summary || "").toString().trim();

    // LINE用に整形（AI前置きの掃除も保険で）
    const toLines = (arr, label) => arr.length ? `\n【${label}】\n- ` + arr.join("\n- ") : "";
    const msg =
      `■診察メモ\n` +
      `${j.summary}\n` +
      toLines(j.decisions, "決まったこと") +
      toLines(j.todos_until_next, "次回までのTODO") +
      toLines(j.ask_next_time, "次回ききたいこと") +
      toLines(j.red_flags, "注意サイン");
    const cleaned = msg
      .replace(/^はい[、。]?(承知|了解)(いたしました|しました)。?\s*/i, "")
      .replace(/^(要約|生成|まとめ)[：:]\s*/i, "");

    // LINE Push
    const jobsDir = path.join(DATA_DIR, "jobs");
    const meta = JSON.parse(fs.readFileSync(path.join(jobsDir, `${jobId}.json`), "utf-8"));
  try {
   await lineClient.pushMessage({ to: meta.userId, messages:[{ type:"text", text: cleaned.slice(0,4999) }] });
 } catch (e) {
   console.error("LINE push failed:", e?.statusCode, e?.message);
 }
    return res.json({ ok: true, status: "DONE", transcript, summary: cleaned });
   } catch (e) {
     console.error("[/jobs] error", e);
     return res.status(500).json({ ok: false, error: String(e) });
   }
 });

// LINE Webhook（必要なら返信もできる）
app.post("/line/webhook", express.json(), async (req, res) => {
  res.status(200).end(); // すぐOK返す
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
    console.error(e);
  }
});

// どこからでも受ける
const HOST = '0.0.0.0';

// ヘルス用（Cloud Run は / で見ることが多い）
app.get('/', (_, res) => res.json({ ok: true }));

app.listen(PORT, HOST, () => {
  console.log(`yorisoi mvp listening on ${HOST}:${PORT}`);
});

// ---- helper ----
function execFFmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-y", ...args], { windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || String(err)));
      resolve();
    });
  });

}
