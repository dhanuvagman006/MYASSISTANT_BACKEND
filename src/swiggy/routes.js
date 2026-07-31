/**
 * /swiggy — account-link endpoints (mirror of src/google/routes.js).
 *   GET    /swiggy/status    → { linked }
 *   GET    /swiggy/connect   → { url }  (app opens it; phone + OTP in browser)
 *   GET    /swiggy/callback  → OAuth redirect target (tiny HTML close page)
 *   DELETE /swiggy           → unlink
 */
const router = require("express").Router();
const tokens = require("./tokens");

function uid(req) {
  const id = Number(req.user?.sub);
  return Number.isInteger(id) && id > 0 ? id : null;
}

router.get("/status", async (req, res) => {
  const userId = uid(req);
  res.json({ linked: userId ? await tokens.isLinked(userId) : false });
});

router.get("/connect", async (req, res) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ error: "sign in first" });
  try {
    res.json({ url: await tokens.beginLink(userId) });
  } catch (e) {
    console.error("swiggy connect:", e.message);
    res.status(502).json({ error: "Swiggy link unavailable right now" });
  }
});

// Public: reached by browser redirect, identified by signed state, not JWT.
router.get("/callback", async (req, res) => {
  const { state, code, error } = req.query;
  const page = (msg) =>
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<body style="font-family:sans-serif;display:grid;place-items:center;height:90vh">` +
    `<div style="text-align:center"><h2>${msg}</h2><p>You can close this tab and return to Hari.</p></div>`;
  if (error) return res.status(400).send(page("Swiggy link cancelled"));
  try {
    await tokens.completeLink(String(state || ""), String(code || ""));
    res.send(page("Swiggy connected ✅"));
  } catch (e) {
    console.error("swiggy callback:", e.message);
    res.status(400).send(page("Link failed — please try again"));
  }
});

router.delete("/", (req, res) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ error: "sign in first" });
  tokens.unlink(userId);
  res.json({ ok: true });
});

module.exports = router;
