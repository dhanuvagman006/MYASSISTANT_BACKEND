/**
 * GOOGLE LINK ROUTES (behind appAuth)
 * POST   /google/connect  { serverAuthCode }  → { ok }
 * GET    /google/status                       → { connected }
 * DELETE /google                              → { ok }   (revokes at Google)
 * GET    /google/inbox                        → { emails } | 409 not linked
 * GET    /google/calendar?days=7              → { events } | 409 not linked
 */
const router = require("express").Router();
const tokens = require("./tokens");
const gapi = require("./api");
const audit = require("../audit/log");

function uid(req, res) {
  const id = Number(req.user?.sub);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "requires a signed-in account" });
    return null;
  }
  return id;
}

router.post("/connect", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const code = req.body?.serverAuthCode;
  if (!code) return res.status(400).json({ error: "serverAuthCode required" });
  if (!process.env.GOOGLE_WEB_CLIENT_SECRET) {
    return res.status(500).json({ error: "server missing GOOGLE_WEB_CLIENT_SECRET" });
  }
  try {
    await tokens.connect(id, code);
    res.json({ ok: true });
  } catch (e) {
    console.warn("google connect failed:", e.message);
    res.status(400).json({ error: "could not link Google account" });
  }
});

router.get("/status", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  res.json({ connected: await tokens.isConnected(id) });
});

router.delete("/", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  await tokens.disconnect(id);
  res.json({ ok: true });
});

router.get("/inbox", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    const emails = await gapi.recentEmails(id);
    if (emails === null) return res.status(409).json({ error: "not linked" });
    res.json({ emails });
  } catch (e) {
    res.status(502).json({ error: "gmail unavailable" });
  }
});

router.get("/calendar", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    const events = await gapi.upcomingEvents(id, {
      days: Math.min(Number(req.query.days) || 7, 31),
    });
    if (events === null) return res.status(409).json({ error: "not linked" });
    res.json({ events });
  } catch (e) {
    res.status(502).json({ error: "calendar unavailable" });
  }
});

// ---------- WRITE endpoints (D2 · D3 · D4) ----------

/** FOCUS GUARD — analyse the coming week for overload; returns proposed
 *  30-min buffers + reschedule candidates. READ-ONLY: applying a buffer
 *  is the app calling the existing POST /google/event after the user
 *  approves the preview (same rule as D3 — the server never self-inserts). */
router.get("/focus-plan", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    const events = await gapi.upcomingEvents(id, {
      days: Math.min(Number(req.query.days) || 7, 31),
      max: 100,
    });
    if (events === null) return res.status(409).json({ error: "not linked" });
    const plan = require("./focus").analyzeLoad(events, {
      tzOffsetMin: Number(req.query.tzOffsetMin) || 0,
    });
    res.json(plan);
  } catch (e) {
    res.status(502).json({ error: "calendar unavailable" });
  }
});

/** D3 — create a calendar event (the app shows a preview and the user
 *  approves BEFORE calling this; voice creation confirms by speech). */
router.post("/event", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const { title, startMs, endMs, location, description } = req.body || {};
  const start = Number(startMs);
  if (!title || !Number.isFinite(start)) {
    return res.status(400).json({ error: "title and startMs required" });
  }
  try {
    const ev = await gapi.createEvent(id, {
      title, startMs: start,
      endMs: Number(endMs) || undefined,
      location, description,
    });
    if (ev === null) return res.status(409).json({ error: "not linked" });
    audit.record(id, "calendar.event.created", `${title} — ${new Date(start).toISOString()}`);
    res.status(201).json({ event: ev });
  } catch (e) {
    const scope = /scope/.test(e.message);
    res.status(scope ? 403 : 502).json({
      error: scope
        ? "calendar write permission missing — reconnect Google"
        : "calendar unavailable",
    });
  }
});

/** D2 — save a REPLY DRAFT for a message (never sends). */
router.post("/draft", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const { messageId, to, subject, body } = req.body || {};
  if (!body || (!messageId && !to)) {
    return res.status(400).json({ error: "body plus messageId or to required" });
  }
  try {
    let payload = { to, subject: subject || "(no subject)", body };
    if (messageId) {
      const meta = await gapi.messageMeta(id, String(messageId));
      if (meta === null) return res.status(409).json({ error: "not linked" });
      if (!meta) return res.status(404).json({ error: "message not found" });
      payload = {
        to: meta.replyTo || meta.fromEmail,
        subject: /^re:/i.test(meta.subject) ? meta.subject : "Re: " + meta.subject,
        body,
        threadId: meta.threadId,
        inReplyTo: meta.messageId,
      };
    }
    const draft = await gapi.createDraft(id, payload);
    if (draft === null) return res.status(409).json({ error: "not linked" });
    audit.record(id, "email.draft.created", `to ${payload.to} — ${payload.subject}`);
    res.status(201).json({ draft });
  } catch (e) {
    const scope = /scope/.test(e.message);
    res.status(scope ? 403 : 502).json({
      error: scope
        ? "gmail draft permission missing — reconnect Google"
        : "gmail unavailable",
    });
  }
});

/** D4 — meeting preparation card: next event + recent emails from the
 *  same participants. The Today screen renders this before the event. */
router.get("/meeting-prep", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    const prep = await gapi.meetingPrep(id);
    if (prep === null) return res.status(409).json({ error: "not linked" });
    res.json(prep);
  } catch (e) {
    res.status(502).json({ error: "google unavailable" });
  }
});

module.exports = router;
