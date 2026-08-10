/**
 * SPEECH-TO-TEXT — GEMINI ONLY. Audio is a first-class input to
 * gemini-2.0-flash; the same GEMINI_API_KEY powers the whole voice loop
 * (STT + chat + streaming).
 *
 * POST /stt (multipart "audio") -> { text, language }
 */
const router = require("express").Router();
const multer = require("multer");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 }, // ~15s of AAC is far below this
});

// ---------------- HALLUCINATION GUARD ----------------
// On silence / faint background noise Whisper famously invents YouTube
// filler ("Welcome to my channel…", "Thanks for watching") and loops
// short phrases ("1 cup of milk. 1 cup of flour. 1 cup of milk…").
// Returning that as "heard" text is worse than returning nothing.
const HALLUCINATION_RX =
  /welcome to my channel|thank(s| you) for watching|please subscribe|like,? share,? (and )?subscribe|don'?t forget to (like|subscribe)|see you in the next video|字幕|ご視聴ありがとう/i;

function sanitizeTranscript(raw) {
  const t = String(raw || "").trim();
  if (!t) return "";
  if (HALLUCINATION_RX.test(t)) return "";
  // Looping detection: split into phrases; if one phrase dominates by
  // repeating, the whole clip was noise.
  const parts = t
    .split(/(?<=[.!?।|])\s+|\n+/)
    .map((p) => p.trim().toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ""))
    .filter(Boolean);
  if (parts.length >= 4) {
    const counts = new Map();
    for (const p of parts) counts.set(p, (counts.get(p) || 0) + 1);
    const max = Math.max(...counts.values());
    if (max >= 3 && max / parts.length >= 0.4) return "";
  }
  return t;
}

// ---------------- GEMINI ----------------

const { transcribeAudio } = require("../services/ai/router");

router.post("/", upload.single("audio"), async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: "stt not configured" });
  }
  if (!req.file || !req.file.buffer?.length) {
    return res.status(400).json({ error: "audio file required (field 'audio')" });
  }

  // ISO-639-1 codes from the app, e.g. "kn". Sanitized hard.
  const clean = (v) =>
    typeof v === "string" && /^[a-z]{2}$/.test(v.trim()) ? v.trim() : null;
  const language = clean(req.body?.language);
  const hint = clean(req.body?.hint);

  try {
    const out = await transcribeAudio(
      req.file.buffer,
      req.file.mimetype || "audio/mp4",
      { language, hint }
    );
    res.json({
      text: sanitizeTranscript(out.text),
      language: out.language || "unknown",
      provider: "gemini",
    });
  } catch (e) {
    console.error("stt error:", e.message);
    res.status(502).json({ error: "transcription failed" });
  }
});

module.exports = router;
