/**
 * CUSTOM-LLM ENDPOINT for D-ID — POST /did/llm/v1/chat/completions
 *
 * D-ID's avatar agents are configured with `llm.type = "custom"` pointing
 * HERE. So when the user talks to Hari's face, D-ID does the STT + avatar
 * video, and calls this endpoint for the actual words — meaning the face
 * speaks with Hari's REAL brain: per-user memory, saved documents,
 * reminders/weather/news tools, regional language, style prefs. Nothing
 * is duplicated into D-ID's own Knowledge/Memories products (which would
 * also break the India data-residency commitment).
 *
 * Contract (per docs.d-id.com/docs/custom-llms):
 *  - OpenAI-compatible request: { model, messages, stream }
 *  - MUST stream tokens (SSE `data: {...chunk...}` lines, then [DONE])
 *  - Auth: D-ID sends our shared secret in `x-api-key`
 *  - We additionally gave D-ID a per-user header `x-hari-user` (signed
 *    JWT {uid, mode}) at agent-creation time → per-user personalization
 *    with zero trust in the client.
 *
 * Latency: D-ID wants TTFT of 200–500ms. We reuse the same Gemini
 * streaming chain as /chat/stream, which starts in well under a second.
 */
const router = require("express").Router();
const jwt = require("jsonwebtoken");
const { generateReply, generateReplyStream } = require("../services/ai/router");
// Memory module was removed in the core reset; face replies run on the
// base persona + live tool context only.
const { buildToolContext } = require("../services/intents");

const INTERVIEW_DIRECTIVE =
  "\n\nMODE: FIRST-MEETING INTERVIEW. This is your very first conversation with " +
  "this user. Warmly get to know them: their name, their city, what they do, and " +
  "a few things they love. Ask exactly ONE short question at a time, react to " +
  "each answer with genuine warmth, and after you have learned those basics, " +
  "thank them and say they can tap Done to continue into the app.";

const FACE_DIRECTIVE =
  "\n\nMODE: FACE-TO-FACE. The user is watching your face on a live video call. " +
  "Keep the natural 1-3 sentence spoken style; never mention that you are an " +
  "avatar or describe your own appearance unless asked.";

function verifyDid(req, res, next) {
  const secret = process.env.DID_LLM_KEY;
  if (!secret) return res.status(503).json({ error: "custom llm not configured" });
  if (req.get("x-api-key") !== secret) return res.status(401).json({ error: "unauthorized" });
  // Who is talking? Signed at agent-creation; D-ID forwards it verbatim.
  req.hari = { userId: null, mode: "assistant" };
  const tok = req.get("x-hari-user");
  if (tok) {
    try {
      const p = jwt.verify(tok, process.env.JWT_SECRET);
      const uid = Number(p.uid);
      req.hari = {
        userId: Number.isInteger(uid) && uid > 0 ? uid : null,
        mode: p.mode === "interview" ? "interview" : "assistant",
      };
    } catch (_) {
      /* stale token → still answer, just unpersonalized */
    }
  }
  next();
}

/** OpenAI chunk envelope. */
function chunk(id, model, delta, finish = null) {
  return (
    "data: " +
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    }) +
    "\n\n"
  );
}

router.post("/v1/chat/completions", verifyDid, async (req, res) => {
  const { messages = [], model = "hari", stream = true } = req.body || {};
  const { userId, mode } = req.hari;

  // D-ID may include its own system message; keep only user/assistant
  // turns — Hari's system prompt is authoritative and TTS-safe.
  const trimmed = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .slice(-20)
    .map((m) => ({
      role: m.role,
      content: String(
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((p) => p?.text || "").join(" ")
            : ""
      ).slice(0, 8000),
    }));
  if (trimmed.length === 0) trimmed.push({ role: "user", content: "Hello" });

  const id = "chatcmpl-hari-" + Date.now().toString(36);

  try {
    const toolCtx = await buildToolContext({
      userId,
      messages: trimmed,
      tzOffsetMin: 330, // face sessions have no device headers; IST default
    });
    const extraSystem =
      toolCtx.block +
      (mode === "interview" ? INTERVIEW_DIRECTIVE : FACE_DIRECTIVE);

    let full = "";
    if (stream !== false) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();
      res.write(chunk(id, model, { role: "assistant" }));
      try {
        for await (const d of generateReplyStream(trimmed, { extraSystem })) {
          full += d;
          res.write(chunk(id, model, { content: d }));
        }
      } catch (e) {
        if (!full) {
          // Streaming provider down → answer whole via fallback chain.
          const { reply } = await generateReply(trimmed, { extraSystem });
          full = reply || "Sorry, I could not answer that.";
          res.write(chunk(id, model, { content: full }));
        }
      }
      res.write(chunk(id, model, {}, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      const { reply } = await generateReply(trimmed, { extraSystem });
      full = reply || "";
      res.json({
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: full },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }

  } catch (e) {
    console.error("did llm failed:", e.message);
    if (!res.headersSent) return res.status(502).json({ error: "unavailable" });
    try {
      res.write(chunk(id, model, { content: "Sorry, something went wrong." }, "stop"));
      res.write("data: [DONE]\n\n");
    } catch (_) {}
    res.end();
  }
});

module.exports = router;
