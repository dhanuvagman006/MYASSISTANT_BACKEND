/**
 * SPEECH-TO-TEXT — Whisper on Groq.
 *
 * The app records the question as a small m4a and posts it here;
 * Whisper AUTO-DETECTS the spoken language (Kannada, Hindi, Tamil,
 * English, mixed…) — no locale guessing, unlike the on-device Android
 * recognizer which proved unreliable for regional languages.
 *
 * POST /stt  (multipart, field "audio")  ->  { text, language }
 */
const router = require("express").Router();
const multer = require("multer");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 }, // ~15s of AAC is far below this
});

router.post("/", upload.single("audio"), async (req, res) => {
  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(503).json({ error: "stt not configured" });
  if (!req.file || !req.file.buffer?.length) {
    return res.status(400).json({ error: "audio file required (field 'audio')" });
  }

  try {
    const fd = new FormData();
    fd.append(
      "file",
      new Blob([req.file.buffer], { type: req.file.mimetype || "audio/m4a" }),
      req.file.originalname || "audio.m4a"
    );
    fd.append("model", process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo");
    fd.append("response_format", "verbose_json"); // includes detected language
    fd.append("temperature", "0");

    const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: fd,
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.error("groq stt", r.status, body.slice(0, 300));
      return res.status(502).json({ error: "transcription failed" });
    }
    const data = await r.json();
    res.json({
      text: (data.text || "").trim(),
      language: data.language || "unknown",
    });
  } catch (e) {
    console.error("stt error:", e.message);
    res.status(502).json({ error: "transcription failed" });
  }
});

module.exports = router;
