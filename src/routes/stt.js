/**
 * SPEECH-TO-TEXT — provider chain, best-for-India first:
 *
 *   1. SARVAM "Saaras v3" (SARVAM_API_KEY) — built specifically for
 *      Indian languages, accents and code-mixed speech (Hinglish /
 *      Kanglish); en-IN Indian English is a first-class language, and
 *      Indic language ID is its home turf. Our 16kHz mono m4a is its
 *      ideal input format.
 *   2. GROQ Whisper large-v3 (GROQ_API_KEY) — solid generalist fallback
 *      (also covers non-Indian languages Sarvam doesn't).
 *
 * Whichever key(s) exist are used; both set = Sarvam first, Whisper on
 * any Sarvam failure. POST /stt (multipart "audio") -> { text, language }
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

// ---------------- GROQ (Whisper large-v3) ----------------

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
  if (!key && !process.env.SARVAM_API_KEY) {
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

  // ---- 1) Sarvam: Indian-accent specialist ----
  const sarvamKey = process.env.SARVAM_API_KEY;
  if (sarvamKey) {
    try {
      const out = await sarvamTranscribe(sarvamKey, req.file, { language, hint });
      if (out.text) return res.json({ ...out, provider: "sarvam" });
      // Empty transcript: fall through to Whisper (may be a non-Indian
      // language Saaras doesn't cover).
    } catch (e) {
      console.warn("sarvam stt failed, falling back:", e.message);
    }
  }

  // ---- 2) Groq Whisper large-v3 ----
  if (!key) return res.status(502).json({ error: "transcription failed" });
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
      provider: "groq-whisper",
    });
  } catch (e) {
    console.error("stt error:", e.message);
    res.status(502).json({ error: "transcription failed" });
  }
});

module.exports = router;
