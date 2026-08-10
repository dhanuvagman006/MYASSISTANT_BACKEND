/**
 * /assistant — the interactive assistant API (session + SSE + turns).
 *
 * App-facing (behind appAuth, mounted in server.js):
 *   POST /assistant/session                  -> {sessionId, streamToken}
 *   POST /assistant/:id/message  {text}      -> 202 (events ride the stream)
 *   POST /assistant/:id/audio    multipart   -> 202 (STT -> same turn flow)
 *   POST /assistant/:id/contacts {matches}   -> 202 (device contact results)
 *   POST /assistant/:id/choose   {contactId} -> 202 (ambiguity resolution)
 *   POST /assistant/:id/confirm  {approved}  -> 202
 *   POST /assistant/:id/cancel               -> 202
 *   GET  /assistant/settings                 -> {discloseAssistant, requireConfirmation}
 *   PUT  /assistant/settings
 *   GET  /assistant/voice/profile            -> {enrolled, label} | {enrolled:false}
 *   POST /assistant/voice/enroll  multipart  -> {ok}
 *   DELETE /assistant/voice/profile
 *
 * Public (no app JWT — see notes):
 *   GET /assistant/stream/:id?token=…  SSE. EventSource can't send our
 *       Authorization header, so the stream is authenticated by a signed
 *       short-lived token minted at session creation.
 *   GET /assistant/audio/:audioId      generated TTS mp3 — Plivo's media
 *       fetcher needs it; the 32-hex random id is the secret.
 */
const router = require("express").Router();
const jwt = require("jsonwebtoken");
const multer = require("multer");
const events = require("./events");
const orchestrator = require("./orchestrator");
const tts = require("./tts");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ---------------- public: SSE stream + generated audio ----------------

router.get("/stream/:id", (req, res) => {
  let sid;
  try {
    const claims = jwt.verify(String(req.query.token || ""), process.env.JWT_SECRET);
    if (claims.kind !== "assistant-stream") throw new Error("wrong kind");
    sid = claims.sid;
  } catch (_) {
    return res.status(401).json({ error: "invalid stream token" });
  }
  if (sid !== req.params.id) return res.status(403).json({ error: "wrong session" });
  const session = events.get(sid);
  if (!session) return res.status(404).json({ error: "session expired" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // nginx: don't buffer the stream
  });
  res.write(`: connected\n\n`);
  session.attach(res, req.get("Last-Event-ID"));

  // Heartbeat keeps proxies from closing the idle socket.
  const beat = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch (_) {
      clearInterval(beat);
    }
  }, 20_000);

  req.on("close", () => {
    clearInterval(beat);
    session.detach(res);
  });
});

router.get("/audio/:audioId", (req, res) => {
  const p = tts.audioPath(req.params.audioId);
  if (!p) return res.status(404).json({ error: "not found" });
  res.type("audio/mpeg").sendFile(p);
});

// ---------------- app-facing (appAuth applied in server.js) ----------------

router.post("/session", (req, res) => {
  const session = events.create(req.user.sub);
  const streamToken = jwt.sign(
    { kind: "assistant-stream", sid: session.id },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
  res.json({ sessionId: session.id, streamToken });
});

/** Loads the caller's session or 404s. */
function sessionOf(req, res) {
  const s = events.get(req.params.id, req.user.sub);
  if (!s) {
    res.status(404).json({ error: "session not found or expired" });
    return null;
  }
  return s;
}

router.post("/:id/message", (req, res) => {
  const s = sessionOf(req, res);
  if (!s) return;
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "text required" });
  res.status(202).json({ ok: true });
  orchestrator
    .handleUserMessage(s, text, { userName: req.user.name })
    .catch((e) => console.error("assistant message error:", e));
});

// ---------------- STT: Deepgram Nova-2 (optional) -> Gemini fallback ----------------

async function deepgramTranscribe(file) {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return null;
  const u = new URL("https://api.deepgram.com/v1/listen");
  u.searchParams.set("model", process.env.DEEPGRAM_MODEL || "nova-2");
  u.searchParams.set("smart_format", "true");
  u.searchParams.set("detect_language", "true");
  const r = await fetch(u, {
    method: "POST",
    headers: {
      Authorization: `Token ${key}`,
      "Content-Type": file.mimetype || "audio/m4a",
    },
    signal: AbortSignal.timeout(30_000),
    body: file.buffer,
  });
  if (!r.ok) throw new Error(`deepgram ${r.status}`);
  const data = await r.json();
  const alt = data.results?.channels?.[0]?.alternatives?.[0];
  return {
    text: String(alt?.transcript || "").trim(),
    language: data.results?.channels?.[0]?.detected_language || "en",
    provider: "deepgram",
  };
}

async function geminiTranscribe(file) {
  if (!process.env.GEMINI_API_KEY) return null;
  const { transcribeAudio } = require("../services/ai/router");
  const out = await transcribeAudio(file.buffer, file.mimetype || "audio/mp4");
  return { text: out.text, language: out.language || "auto", provider: "gemini" };
}

router.post("/:id/audio", upload.single("audio"), async (req, res) => {
  const s = sessionOf(req, res);
  if (!s) return;
  if (!req.file?.buffer?.length) {
    return res.status(400).json({ error: "audio file required (field: audio)" });
  }
  res.status(202).json({ ok: true });

  s.setState("transcribing");
  let out = null;
  for (const fn of [deepgramTranscribe, geminiTranscribe]) {
    try {
      out = await fn(req.file);
      if (out) break;
    } catch (e) {
      console.warn("assistant stt:", e.message);
    }
  }
  if (!out || !out.text) {
    s.emit({ type: "error", message: "I couldn't hear that — please try again." });
    return s.setState("idle");
  }
  orchestrator
    .handleUserMessage(s, out.text, { userName: req.user.name })
    .catch((e) => console.error("assistant audio turn error:", e));
});

router.post("/:id/contacts", (req, res) => {
  const s = sessionOf(req, res);
  if (!s) return;
  res.status(202).json({ ok: true });
  orchestrator
    .onContactsResolved(s, req.body?.matches)
    .catch((e) => console.error("assistant contacts error:", e));
});

router.post("/:id/choose", (req, res) => {
  const s = sessionOf(req, res);
  if (!s) return;
  res.status(202).json({ ok: true });
  orchestrator
    .onContactChosen(s, req.body?.contactId)
    .catch((e) => console.error("assistant choose error:", e));
});

router.post("/:id/confirm", (req, res) => {
  const s = sessionOf(req, res);
  if (!s) return;
  res.status(202).json({ ok: true });
  orchestrator
    .onConfirm(s, Boolean(req.body?.approved), { userName: req.user.name })
    .catch((e) => console.error("assistant confirm error:", e));
});

router.post("/:id/cancel", (req, res) => {
  const s = sessionOf(req, res);
  if (!s) return;
  orchestrator.cancel(s);
  res.status(202).json({ ok: true });
});

// ---------------- settings + voice profile ----------------

router.get("/settings", async (req, res) => {
  res.json(await orchestrator.getSettings(req.user.sub));
});

router.put("/settings", async (req, res) => {
  res.json(await orchestrator.setSettings(req.user.sub, req.body || {}));
});

router.get("/voice/profile", async (req, res) => {
  const p = await tts.getProfile(req.user.sub).catch(() => null);
  res.json(
    p
      ? { enrolled: true, label: p.label, createdAt: Number(p.created_at) }
      : { enrolled: false, available: tts.configured() }
  );
});

router.post("/voice/enroll", upload.single("audio"), async (req, res) => {
  if (!req.file?.buffer?.length) {
    return res.status(400).json({ error: "audio sample required (field: audio)" });
  }
  try {
    await tts.enrollVoice(req.user.sub, req.file, req.body?.label);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === "not_configured") {
      return res.status(503).json({ error: e.message });
    }
    console.error("voice enroll failed:", e.message);
    res.status(502).json({ error: "voice enrollment failed" });
  }
});

router.delete("/voice/profile", async (req, res) => {
  await tts.deleteProfile(req.user.sub).catch(() => {});
  res.json({ ok: true });
});

module.exports = router;
