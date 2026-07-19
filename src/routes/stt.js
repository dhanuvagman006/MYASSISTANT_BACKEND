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

// Whisper misdetects Kannada/Telugu/etc. as Hindi on short clips (heavy
// shared Sanskrit vocabulary). Two counters, sent by the app:
//   language=kn  -> FORCE that language (user picked it in the app)
//   hint=kn      -> BIAS detection with a prompt in that script (Auto
//                   mode with a known region) — other languages still work.
const HINT_PROMPT = {
  kn: "ಕನ್ನಡದಲ್ಲಿ ಮಾತನಾಡುತ್ತಿದ್ದೇನೆ.",
  hi: "मैं हिंदी में बात कर रहा हूँ।",
  ta: "நான் தமிழில் பேசுகிறேன்.",
  te: "నేను తెలుగులో మాట్లాడుతున్నాను.",
  ml: "ഞാൻ മലയാളത്തിൽ സംസാരിക്കുന്നു.",
  mr: "मी मराठीत बोलत आहे.",
  gu: "હું ગુજરાતીમાં બોલી રહ્યો છું.",
  bn: "আমি বাংলায় কথা বলছি।",
  pa: "ਮੈਂ ਪੰਜਾਬੀ ਵਿੱਚ ਗੱਲ ਕਰ ਰਿਹਾ ਹਾਂ।",
  ur: "میں اردو میں بات کر رہا ہوں۔",
};

async function groqTranscribe(key, file, { language, hint } = {}) {
  const fd = new FormData();
  fd.append(
    "file",
    new Blob([file.buffer], { type: file.mimetype || "audio/m4a" }),
    file.originalname || "audio.m4a"
  );
  // large-v3 (not turbo): clearly better language ID for Indic languages.
  fd.append("model", process.env.GROQ_STT_MODEL || "whisper-large-v3");
  fd.append("response_format", "verbose_json");
  fd.append("temperature", "0");
  if (language) fd.append("language", language);
  else if (hint && HINT_PROMPT[hint]) fd.append("prompt", HINT_PROMPT[hint]);

  return fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: fd,
    signal: AbortSignal.timeout(30_000),
  });
}

router.post("/", upload.single("audio"), async (req, res) => {
  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(503).json({ error: "stt not configured" });
  if (!req.file || !req.file.buffer?.length) {
    return res.status(400).json({ error: "audio file required (field 'audio')" });
  }

  // ISO-639-1 codes from the app, e.g. "kn". Sanitized hard.
  const clean = (v) =>
    typeof v === "string" && /^[a-z]{2}$/.test(v.trim()) ? v.trim() : null;
  const language = clean(req.body?.language);
  const hint = clean(req.body?.hint);

  try {
    let r = await groqTranscribe(key, req.file, { language, hint });
    // If Groq rejects the forced language (unsupported code), retry free.
    if (!r.ok && language) {
      r = await groqTranscribe(key, req.file, { hint });
    }
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
