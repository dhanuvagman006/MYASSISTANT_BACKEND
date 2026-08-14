/**
 * TEXT-TO-SPEECH — GEMINI NATIVE NEURAL VOICE.
 * The same GEMINI_API_KEY that powers chat + STT also generates a warm,
 * human-sounding voice, replacing the phone's robotic on-device TTS.
 *
 * POST /tts  { text, language?, voice? }  ->  audio/wav (24 kHz PCM)
 *
 * The app streams the reply sentence-by-sentence, so each request is one
 * short sentence — low latency, and the client can start playback while
 * the next sentence is still being synthesized.
 */
const router = require("express").Router();
const { synthesizeSpeech } = require("../services/ai/router");

router.post("/", async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: "tts not configured" });
  }

  const text = String(req.body?.text || "").trim();
  if (!text) {
    return res.status(400).json({ error: "text required" });
  }
  // Guard against oversized inputs (one spoken sentence is tiny).
  if (text.length > 1200) {
    return res.status(413).json({ error: "text too long" });
  }

  const clean2 = (v) =>
    typeof v === "string" && /^[a-z]{2}$/i.test(v.trim())
      ? v.trim().toLowerCase()
      : undefined;

  try {
    // The assistant's configured voice (Settings → Assistant) applies
    // unless this request names one explicitly.
    let voice =
      typeof req.body?.voice === "string" ? req.body.voice : undefined;
    const uid = Number(req.user?.sub);
    if (!voice && Number.isFinite(uid) && uid > 0) {
      try {
        const p = await require("../users/context").getProfile(uid);
        voice = p?.assistant?.voice || undefined;
      } catch (_) {}
    }
    const { wav } = await synthesizeSpeech(text, {
      language: clean2(req.body?.language),
      voice,
    });
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Length", wav.length);
    // Same sentence -> same audio; let the client cache briefly.
    res.setHeader("Cache-Control", "private, max-age=60");
    res.send(wav);
  } catch (e) {
    console.error("tts error:", e.message);
    res.status(502).json({ error: "synthesis failed" });
  }
});

module.exports = router;
