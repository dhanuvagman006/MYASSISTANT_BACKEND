/**
 * SPEECH-TO-TEXT — provider chain, best-for-India first:
 *
 *   1. SARVAM "Saaras v3" (SARVAM_API_KEY, optional) — built specifically
 *      for Indian languages, accents and code-mixed speech.
 *   2. GEMINI (GEMINI_API_KEY) — audio is a first-class input to
 *      gemini-2.0-flash; one key now powers the WHOLE voice loop
 *      (STT + chat + streaming). Replaces the old Groq Whisper path.
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

// ---------------- SARVAM (Saaras v3) ----------------

// ISO-639-1 → Sarvam BCP-47. Only languages Saaras supports; anything
// else falls back to auto-detect ("unknown").
const SARVAM_LANG = {
  hi: "hi-IN", bn: "bn-IN", kn: "kn-IN", ml: "ml-IN", mr: "mr-IN",
  or: "od-IN", pa: "pa-IN", ta: "ta-IN", te: "te-IN", en: "en-IN",
  gu: "gu-IN", as: "as-IN", ur: "ur-IN", ne: "ne-IN", sa: "sa-IN",
};

async function sarvamTranscribe(key, file, { language, hint } = {}) {
  const fd = new FormData();
  fd.append(
    "file",
    new Blob([file.buffer], { type: file.mimetype || "audio/m4a" }),
    file.originalname || "audio.m4a"
  );
  fd.append("model", process.env.SARVAM_STT_MODEL || "saaras:v3");
  fd.append("mode", "transcribe");
  // Forced language locks it; a hint also locks here (Saaras has no
  // soft-bias parameter) but its Indic auto-detect is strong enough
  // that we only lock on the USER'S explicit pick, not the region hint.
  if (language && SARVAM_LANG[language]) {
    fd.append("language_code", SARVAM_LANG[language]);
  } else {
    fd.append("language_code", "unknown"); // auto-detect (its specialty)
  }

  const r = await fetch("https://api.sarvam.ai/speech-to-text", {
    method: "POST",
    headers: { "api-subscription-key": key },
    body: fd,
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`sarvam ${r.status} ${body.slice(0, 200)}`);
  }
  const data = await r.json();
  return {
    text: (data.transcript || "").trim(),
    language: (data.language_code || "unknown").split("-")[0],
  };
}

// ---------------- GEMINI ----------------

const { transcribeAudio } = require("../services/ai/router");

router.post("/", upload.single("audio"), async (req, res) => {
  if (!process.env.GEMINI_API_KEY && !process.env.SARVAM_API_KEY) {
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

  // ---- 1) Sarvam: Indian-accent specialist (only if its key is set) ----
  const sarvamKey = process.env.SARVAM_API_KEY;
  if (sarvamKey) {
    try {
      const out = await sarvamTranscribe(sarvamKey, req.file, { language, hint });
      out.text = sanitizeTranscript(out.text);
      if (out.text) return res.json({ ...out, provider: "sarvam" });
      // Empty transcript: fall through to Gemini.
    } catch (e) {
      console.warn("sarvam stt failed, falling back:", e.message);
    }
  }

  // ---- 2) Gemini ----
  if (!process.env.GEMINI_API_KEY) {
    return res.status(502).json({ error: "transcription failed" });
  }
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
