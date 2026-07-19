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

router.get("/status", (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  res.json({ connected: tokens.isConnected(id) });
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

module.exports = router;
