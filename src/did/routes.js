/**
 * D-ID ROUTES — Face Mode sessions + the hosted face page + briefings.
 *
 *   GET  /did/status      → { enabled, faceAllowed, reason }   (app JWT)
 *   POST /did/session     → { faceUrl }                        (app JWT)
 *        body: { mode: "assistant" | "interview" }
 *        Ensures this user's D-ID agent exists (custom-LLM → our server),
 *        mints a client key + a short-lived signed page token, and returns
 *        the URL of OUR hosted face page for the app's WebView.
 *   GET  /did/face?t=…    → HTML page embedding the D-ID agent (no JWT —
 *        the signed one-time-style token in the query IS the auth).
 *   GET  /did/briefing    → today's video briefing row (app JWT)
 *   POST /did/briefing    → generate today's briefing (app JWT, Pro)
 *
 * Monetization: Face Mode + video briefings are PRO features — the first
 * genuinely premium thing in the upgrade screen. The one exception is the
 * first-meeting interview: every new user gets ONE face-to-face hello
 * (short session, bounded cost, unforgettable first impression).
 */
const router = require("express").Router();
const jwt = require("jsonwebtoken");
const did = require("./client");
const store = require("./store");
const db = require("../db");
const { todayBriefing } = require("./briefing");
const { effectivePlan } = require("../billing/store");
const { isPaidPlan } = require("../billing/plans");

const SESSION_MIN = 30; // face page token lifetime

function userIdOf(req) {
  const id = Number(req.user?.sub);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function publicBase() {
  return (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
}

async function faceAllowed(userId, mode) {
  if (mode === "interview") return { ok: true }; // one warm hello for everyone
  if (!userId) return { ok: false, reason: "sign in required" };
  const plan = await effectivePlan(userId);
  if (!isPaidPlan(plan.plan)) return { ok: false, reason: "pro required" };
  return { ok: true };
}

/* ------------------------- status ------------------------- */
router.get("/status", async (req, res) => {
  const userId = userIdOf(req);
  if (!did.enabled() || !publicBase()) {
    return res.json({ enabled: false, faceAllowed: false, reason: "not configured" });
  }
  const gate = await faceAllowed(userId, "assistant");
  res.json({ enabled: true, faceAllowed: gate.ok, reason: gate.reason || null });
});

/* ------------------------- session ------------------------- */
router.post("/session", async (req, res) => {
  const userId = userIdOf(req);
  const mode = req.body?.mode === "interview" ? "interview" : "assistant";
  if (!did.enabled() || !publicBase()) {
    return res.status(503).json({ error: "face mode not configured" });
  }
  const gate = await faceAllowed(userId, mode);
  if (!gate.ok) return res.status(402).json({ error: gate.reason, code: "pro_required" });

  try {
    // Avatar gender = OPPOSITE of the user's (client spec): a male user
    // talks to a girl's face, a female user to a boy's. Unset -> female.
    const account = userId ? await db.findById(userId) : null;
    const avatarGender = account?.gender === "female" ? "male" : "female";

    // 1) Ensure this user's agent (per mode+gender) exists on D-ID — the
    // gender is part of the cache key so changing it rebuilds the face.
    const modeKey = `${mode}:${avatarGender}`;
    let agentId = (await store.getAgent(userId || 0, modeKey))?.agent_id;
    if (!agentId) {
      // Long-lived token D-ID replays to /did/llm on every turn.
      const userToken = jwt.sign({ uid: userId || 0, mode }, process.env.JWT_SECRET, {
        expiresIn: "365d",
      });
      const agent = await did.createAgent({
        avatarGender,
        name: mode === "interview" ? "Hari (first meeting)" : "Hari",
        llmUrl: `${publicBase()}/did/llm/v1/chat/completions`,
        llmKey: process.env.DID_LLM_KEY,
        userToken,
        greeting:
          mode === "interview"
            ? "Hi, I'm Hari — so nice to finally meet you face to face! What should I call you?"
            : "Hello! Lovely to see you. How can I help?",
      });
      agentId = agent.id;
      await store.saveAgent(userId || 0, modeKey, agentId);
    }

    // 2) Client key locked to OUR hosted page's origin.
    const ck = await did.createClientKey(agentId, [publicBase()]);
    const clientKey = ck.client_key || ck.key || ck.id;

    // 3) Signed page token → the WebView URL carries everything it needs.
    const t = jwt.sign(
      { a: agentId, k: clientKey, m: mode, uid: userId || 0 },
      process.env.JWT_SECRET,
      { expiresIn: `${SESSION_MIN}m` }
    );
    res.json({ faceUrl: `${publicBase()}/did/face?t=${encodeURIComponent(t)}` });
  } catch (e) {
    console.error("did session failed:", e.message);
    res.status(502).json({ error: "could not start face session" });
  }
});

/* ------------------------- hosted face page ------------------------- */
/**
 * Served to the app's WebView. Embeds D-ID's Agents Embed (script tag +
 * client key — per docs.d-id.com/docs/embed-quickstart) styled to the
 * brand. Kept server-side ON PURPOSE: the face UI can be restyled or
 * fixed for every installed app with a redeploy — same philosophy as the
 * remote-config switchboard.
 */
router.get("/face", (req, res) => {
  let p;
  try {
    p = jwt.verify(String(req.query.t || ""), process.env.JWT_SECRET);
  } catch (_) {
    return res.status(401).send("Session expired — please reopen Face Mode.");
  }
  const esc = (s) => String(s).replace(/[^\w@:.\-]/g, "");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // The embed needs mic + WebRTC; explicitly allow them for this page.
  res.setHeader("Permissions-Policy", "microphone=(self), camera=(self)");
  res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Hari</title>
<style>
  :root { --peacock:#0F6B66; --marigold:#F6A21E; --ink:#0E1B1D; --mist:#F2F6F5; }
  html,body { margin:0; height:100%; background:var(--ink); color:var(--mist);
              font-family:system-ui,-apple-system,sans-serif; overflow:hidden; }
  #stage { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; }
  #loading { position:fixed; inset:0; display:flex; flex-direction:column; gap:14px;
             align-items:center; justify-content:center; background:var(--ink);
             transition:opacity .4s; z-index:5; }
  .orb { width:64px; height:64px; border-radius:50%;
         border:3px solid var(--marigold); position:relative; animation:pulse 1.6s infinite; }
  .orb::after { content:""; position:absolute; inset:20px; border-radius:50%; background:var(--peacock); }
  @keyframes pulse { 0%,100%{transform:scale(1);opacity:.9} 50%{transform:scale(1.12);opacity:1} }
  #loading p { font-size:15px; opacity:.85 }
  /* Let the embedded agent fill the phone screen */
  did-agent, #did-container, [data-name="did-agent"] { width:100vw; height:100vh; }
</style>
</head>
<body>
  <div id="loading"><div class="orb"></div><p>${
    p.m === "interview" ? "Hari is coming to meet you…" : "Bringing Hari to life…"
  }</p></div>
  <div id="stage"></div>
  <script type="module"
    src="https://agent.d-id.com/v2/index.js"
    data-mode="full"
    data-client-key="${esc(p.k)}"
    data-agent-id="${esc(p.a)}"
    data-name="did-agent"
    data-monitor="false"></script>
  <script>
    // Hide the loader as soon as the agent's UI attaches.
    const hide = () => { const l = document.getElementById('loading');
      if (l) { l.style.opacity = 0; setTimeout(() => l.remove(), 450); } };
    const obs = new MutationObserver(() => {
      if (document.querySelector('did-agent, [data-name="did-agent"], iframe, video')) {
        hide(); obs.disconnect();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(hide, 12000); // never trap the user on the loader
  </script>
</body>
</html>`);
});

/* ------------------------- daily video briefing ------------------------- */
async function briefingHandler(req, res, generate) {
  const userId = userIdOf(req);
  if (!did.enabled()) return res.status(503).json({ error: "not configured" });
  if (!userId) return res.status(401).json({ error: "sign in required" });
  if (generate) {
    const plan = await effectivePlan(userId);
    if (!isPaidPlan(plan.plan)) {
      return res.status(402).json({ error: "pro required", code: "pro_required" });
    }
  }
  try {
    const row = await todayBriefing(userId, {
      tzOffsetMin: Number(req.get("X-TZ-Offset")) || 330,
      lat: parseFloat(req.get("X-Geo-Lat")),
      lng: parseFloat(req.get("X-Geo-Lng")),
      generate,
    });
    if (!row) return res.json({ status: "none" });
    res.json({ status: row.status, url: row.result_url || null });
  } catch (e) {
    console.error("briefing failed:", e.message);
    res.status(502).json({ error: "briefing unavailable" });
  }
}
router.get("/briefing", (req, res) => briefingHandler(req, res, false));
router.post("/briefing", (req, res) => briefingHandler(req, res, true));

module.exports = router;
