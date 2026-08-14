/**
 * LIVE ROOM PAGE (§2, §21, §25, §29) — a minimal, auto-joining WebRTC
 * room the app's WebView loads instead of Daily's Prebuilt meeting UI.
 *
 * WHY: the Tavus `conversation_url` is a Daily room. Loaded raw, Daily
 * Prebuilt shows its full meeting shell — including the "Enter your
 * name" haircheck that made the assistant feel like an anonymous
 * meeting bot. This page uses the daily-js CALL OBJECT instead:
 *
 *   • joins immediately with the AUTHENTICATED user's name (§2, §25)
 *   • renders ONLY the avatar's video+audio, full-bleed (§29)
 *   • user camera stays OFF (the assistant doesn't need to see you,
 *     and not encoding/uploading camera video saves real CPU, §21)
 *   • no meeting chrome, no chat, no participant list to render
 *
 * The Flutter readiness probe is unchanged: it still watches for a
 * genuinely playing <video>, which this page produces only when the
 * avatar's track actually flows.
 *
 * GET /avatar/room?u=<daily room url>&n=<display name>
 * Public route (a WebView carries no auth header); it embeds nothing
 * secret — only the room URL the caller already holds — and refuses
 * non-Daily URLs so it can't be used to frame arbitrary sites.
 */
const router = require("express").Router();

function dailyUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    if (u.protocol !== "https:") return null;
    if (!u.hostname.endsWith(".daily.co")) return null;
    return u.toString();
  } catch (_) {
    return null;
  }
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

router.get("/", (req, res) => {
  const room = dailyUrl(req.query.u);
  if (!room) return res.status(400).send("invalid room");
  const name = String(req.query.n || "You").slice(0, 60);

  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>
  html,body{margin:0;height:100%;background:#06080E;overflow:hidden}
  video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#06080E}
</style>
</head><body>
<video id="v" autoplay playsinline></video>
<audio id="a" autoplay></audio>
<script src="https://unpkg.com/@daily-co/daily-js"></script>
<script>
(function () {
  var D = window.Daily || window.DailyIframe;
  if (!D) { document.title = 'load-failed'; return; }
  var call = D.createCallObject();
  function attach(track) {
    try {
      var el = track.kind === 'video'
        ? document.getElementById('v')
        : document.getElementById('a');
      el.srcObject = new MediaStream([track]);
      var p = el.play(); if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }
  call.on('track-started', function (e) {
    if (e && e.participant && !e.participant.local && e.track) attach(e.track);
  });
  call.on('error', function () { document.title = 'call-error'; });
  call.join({
    url: ${JSON.stringify(room)},
    userName: ${JSON.stringify(esc(name))},
    startVideoOff: true,   // user camera off: privacy + CPU (§21)
    startAudioOff: false   // mic on: this is a conversation
  });
})();
</script>
</body></html>`);
});

module.exports = router;
