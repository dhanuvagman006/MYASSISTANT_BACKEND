/**
 * AGENT-CALL ROUTES
 *
 * App-facing (behind appAuth):
 *   POST /agent-call/preview  { contactName, task, lang? } -> { opening, allowed, reason? }
 *   POST /agent-call          { toNumber, contactName, task, lang? } -> 202 { id }
 *                              503 when telephony not configured (app falls back
 *                              to a direct dial); 402 over the daily limit.
 *   GET  /agent-call/:id      -> { state, result? }
 *
 * Public (Plivo calls these — NO app auth; guarded by a per-call token in the
 * path and mounted before appAuth in server.js):
 *   POST /agent-call/plivo/:id/:token/answer  -> Plivo XML
 *   POST /agent-call/plivo/:id/:token/gather  -> Plivo XML
 *   POST /agent-call/plivo/:id/:token/hangup  -> 204
 */

const express = require("express");
const agent = require("../agents/agentCall");

function uidOf(req) {
  const id = Number(req.user?.sub);
  return Number.isInteger(id) && id > 0 ? id : null;
}
function firstName(req) {
  const n = req.user?.name;
  return n ? String(n).split(" ")[0] : null;
}

// ---------------- APP-FACING ROUTER (mounted WITH appAuth) ----------------

const router = express.Router();

router.post("/preview", async (req, res) => {
  const contactName = String(req.body?.contactName || "").trim();
  const task = String(req.body?.task || "").trim();
  const lang = req.body?.lang ? String(req.body.lang) : null;
  if (!contactName || !task) {
    return res.status(400).json({ error: "contactName and task required" });
  }
  if (!agent.enabled()) {
    // Preview still works so the app can show what WOULD be said; but flag
    // that calling isn't available on this deployment.
    try {
      const p = await agent.preview({
        userName: firstName(req),
        contactName,
        task,
        lang,
      });
      return res.json({ opening: p.opening, allowed: false,
        reason: "Calling on your behalf isn't set up on this server yet, but I can connect you directly." });
    } catch (_) {
      return res.status(502).json({ error: "preview failed" });
    }
  }
  try {
    const p = await agent.preview({
      userName: firstName(req),
      contactName,
      task,
      lang,
    });
    res.json({ opening: p.opening, allowed: p.allowed, reason: p.reason });
  } catch (e) {
    console.error("agent-call preview error:", e.message || e);
    res.status(502).json({ error: "preview failed" });
  }
});

router.post("/", async (req, res) => {
  const toNumber = String(req.body?.toNumber || "").trim();
  const contactName = String(req.body?.contactName || "").trim();
  const task = String(req.body?.task || "").trim();
  const lang = req.body?.lang ? String(req.body.lang) : null;
  if (!toNumber || !contactName || !task) {
    return res
      .status(400)
      .json({ error: "toNumber, contactName and task required" });
  }
  if (!agent.enabled()) {
    return res.status(503).json({ error: "agent calling not configured" });
  }
  try {
    const { id } = await agent.start({
      userId: uidOf(req),
      userName: firstName(req),
      toNumber,
      contactName,
      task,
      lang,
    });
    res.status(202).json({ id });
  } catch (e) {
    if (e?.code === "unavailable") {
      return res.status(503).json({ error: "agent calling not configured" });
    }
    if (e?.code === "quota") {
      return res.status(402).json({
        error: "quota",
        message: "You've reached today's limit for calls I place for you.",
      });
    }
    if (e?.code === "bad_number") {
      return res.status(400).json({ error: "invalid number" });
    }
    console.error("agent-call start error:", e.message || e);
    res.status(502).json({ error: "could not start call" });
  }
});

router.get("/:id", (req, res) => {
  const s = agent.status(String(req.params.id));
  if (!s) return res.status(404).json({ error: "unknown call" });
  res.json(s);
});

// ---------------- PUBLIC WEBHOOKS (mounted WITHOUT appAuth) ----------------

const webhooks = express.Router();
// Plivo posts application/x-www-form-urlencoded.
webhooks.use(express.urlencoded({ extended: false }));

function sendXml(res, xml) {
  res.set("Content-Type", "text/xml").send(xml);
}
// A minimal, always-valid "goodbye" XML for any error path.
function byeXml() {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Speak>Sorry, goodbye.</Speak><Hangup/></Response>`
  );
}

webhooks.post("/:id/:token/answer", (req, res) => {
  const rec = agent.get(req.params.id, req.params.token);
  if (!rec) return sendXml(res, byeXml());
  try {
    sendXml(res, agent.answerXml(rec));
  } catch (e) {
    console.error("answer xml error:", e.message || e);
    sendXml(res, byeXml());
  }
});

webhooks.post("/:id/:token/gather", async (req, res) => {
  const rec = agent.get(req.params.id, req.params.token);
  if (!rec) return sendXml(res, byeXml());
  try {
    const xml = await agent.onGather(rec, req.body || {});
    sendXml(res, xml);
  } catch (e) {
    console.error("gather error:", e.message || e);
    sendXml(res, byeXml());
  }
});

webhooks.post("/:id/:token/hangup", (req, res) => {
  const rec = agent.get(req.params.id, req.params.token);
  if (rec) {
    try {
      agent.onHangup(rec, req.body || {});
    } catch (e) {
      console.error("hangup error:", e.message || e);
    }
  }
  res.status(204).end();
});

module.exports = { router, webhooks };
