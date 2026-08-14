/**
 * DEVICE ACTION BRIDGE (§11) — live sessions run the brain on the
 * server, but phone calls and camera happen ON THE DEVICE. When the
 * live agent produces a device action, llm.js queues it here and the
 * app (LiveScreen) receives it over this authenticated SSE stream,
 * executes it with the real device APIs, and acks.
 *
 *   GET  /avatar/actions        SSE: {id, action:{type,...}} per event
 *   POST /avatar/actions/ack    {id}
 */
const router = require("express").Router();
const express = require("express");
const live = require("./llm");

function uidOf(req) {
  const id = Number(req.user?.sub);
  return Number.isInteger(id) && id > 0 ? id : null;
}

router.get("/", (req, res) => {
  const userId = uidOf(req);
  if (!userId) return res.status(401).end();
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  live.attachActionListener(userId, res);
  const ping = setInterval(() => {
    try { res.write(": ping\n\n"); } catch (_) {}
  }, 25_000);
  req.on("close", () => {
    clearInterval(ping);
    live.detachActionListener(userId, res);
  });
});

router.post("/ack", express.json(), (req, res) => {
  const userId = uidOf(req);
  if (!userId) return res.status(401).end();
  live.ackAction(userId, req.body?.id);
  res.json({ ok: true });
});

module.exports = router;
