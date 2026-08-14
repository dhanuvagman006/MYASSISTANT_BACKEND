/**
 * LIVE AGENT BRAIN (§10–§14) — an OpenAI-compatible chat-completions
 * endpoint that the Tavus persona's custom-LLM layer calls for every
 * user utterance in a live video session.
 *
 *   Live microphone → Tavus STT → POST /avatar/llm/chat/completions
 *        → THIS module → agents/runtime.runAgentTurn (the SAME unified
 *          agent: user context, standing rules, memory, built-in tools,
 *          MCP tools, permission gating)
 *        → reply streamed back → Tavus TTS + lip-synced avatar video.
 *
 * The video provider handles ONLY media (§10). Identity comes from the
 * per-user bearer key minted with the persona (avatar_personas), never
 * from the room (§3).
 *
 * HIGH-RISK ACTIONS (§14): when the agent halts for confirmation, the
 * avatar ASKS out loud and the pending action is parked per-user; a
 * spoken yes/no on the next turn resolves it — the same gate as the
 * voice loop, spoken instead of tapped.
 *
 * DEVICE ACTIONS (§11): tools that run on the phone (place a call, open
 * the camera) are queued here and delivered to the app over the
 * /avatar/actions SSE stream; the avatar says "calling…", the DEVICE
 * dials, and the agent never claims a result it didn't see.
 */
const router = require("express").Router();
const express = require("express");
const { one } = require("../db");
const runtime = require("../agents/runtime");
const registry = require("../tools/registry");
const memory = require("../agents/memory");
const convoState = require("./state");

/* ------------------------------------------------------------------ */
/* Per-user live state (in-memory; the durable truth stays in the DB)  */
/* ------------------------------------------------------------------ */

/** userId -> { tool, args, summary, expires } awaiting spoken yes/no. */
const pendingConfirm = new Map();

/** userId -> [{ id, action, ts }] device actions awaiting the app. */
const actionQueues = new Map();
/** userId -> Set<res> live SSE listeners. */
const actionListeners = new Map();
let nextActionId = 1;

function queueDeviceAction(userId, action) {
  const item = { id: nextActionId++, action, ts: Date.now() };
  const q = actionQueues.get(userId) || [];
  q.push(item);
  // Never let an unattended queue grow unbounded.
  while (q.length > 20) q.shift();
  actionQueues.set(userId, q);
  for (const res of actionListeners.get(userId) || []) {
    try {
      res.write(`id: ${item.id}\ndata: ${JSON.stringify(item)}\n\n`);
    } catch (_) {}
  }
}

function attachActionListener(userId, res) {
  const set = actionListeners.get(userId) || new Set();
  set.add(res);
  actionListeners.set(userId, set);
  // Replay anything queued while the app wasn't listening yet.
  for (const item of actionQueues.get(userId) || []) {
    res.write(`id: ${item.id}\ndata: ${JSON.stringify(item)}\n\n`);
  }
}

function detachActionListener(userId, res) {
  actionListeners.get(userId)?.delete(res);
}

function ackAction(userId, id) {
  const q = actionQueues.get(userId) || [];
  actionQueues.set(userId, q.filter((i) => i.id !== Number(id)));
}

/* ------------------------------------------------------------------ */
/* Auth: bearer key -> user (§3)                                      */
/* ------------------------------------------------------------------ */

async function userFromBearer(req) {
  const h = String(req.headers.authorization || "");
  const key = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!key || key.length < 24) return null;
  const row = await one(
    `SELECT user_id FROM avatar_personas WHERE api_key=$1`,
    [key]
  );
  return row ? Number(row.user_id) : null;
}

/* ------------------------------------------------------------------ */
/* Spoken yes / no                                                     */
/* ------------------------------------------------------------------ */

const YES = /^\s*(yes|yeah|yep|sure|ok(ay)?|go ahead|do it|please do|confirm|correct|haan|houdu|sari)\b/i;
const NO = /^\s*(no|nope|don'?t|cancel|stop|leave it|not now|nahi|beda|wait)\b/i;

/* ------------------------------------------------------------------ */
/* One live turn                                                       */
/* ------------------------------------------------------------------ */

async function runLiveTurn(userId, messages) {
  // The newest user utterance + a short window of prior turns (§19).
  const lastUser =
    [...messages].reverse().find((m) => m.role === "user")?.content || "";
  const text = typeof lastUser === "string"
    ? lastUser
    : Array.isArray(lastUser)
      ? lastUser.map((p) => p?.text || "").join(" ")
      : String(lastUser || "");
  const history = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-9, -1)
    .map((m) => ({
      role: m.role,
      content:
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }));

  // Durable facts flow into persistent memory in the background (§12, §20).
  memory.extractAndStore(userId, text);

  // Parked high-risk action from the previous turn? (§14)
  const pending = pendingConfirm.get(userId);
  if (pending && pending.expires > Date.now()) {
    if (YES.test(text)) {
      pendingConfirm.delete(userId);
      const res = await registry.execute(pending.tool, pending.args, {
        userId,
        approved: true,
      });
      if (res.deviceAction) queueDeviceAction(userId, res.deviceAction);
      const reply = res.ok
        ? res.speak || "Done."
        : `That didn't work — ${res.error || "the action failed"}.`;
      await convoState.appendTurn(userId, text, reply);
      return reply;
    }
    if (NO.test(text)) {
      pendingConfirm.delete(userId);
      const reply = "Okay, I won't.";
      await convoState.appendTurn(userId, text, reply);
      return reply;
    }
    // Anything else: fall through — the user changed the subject.
    pendingConfirm.delete(userId);
  }

  const out = await runtime.runAgentTurn(text, { userId, history });

  if (out.needsConfirmation) {
    pendingConfirm.set(userId, {
      tool: out.needsConfirmation.tool,
      args: out.needsConfirmation.args,
      expires: Date.now() + 2 * 60 * 1000,
    });
    const reply = `Just to confirm — ${out.needsConfirmation.summary}. Should I go ahead?`;
    await convoState.appendTurn(userId, text, reply);
    return reply;
  }

  for (const a of out.deviceActions || []) queueDeviceAction(userId, a);

  const reply =
    out.text ||
    (out.toolResults?.length ? "Done." : "Sorry, say that again?");
  await convoState.appendTurn(userId, text, reply);
  return reply;
}

/* ------------------------------------------------------------------ */
/* OpenAI-compatible route                                             */
/* ------------------------------------------------------------------ */

router.post(
  "/chat/completions",
  express.json({ limit: "1mb" }),
  async (req, res) => {
    const userId = await userFromBearer(req).catch(() => null);
    if (!userId) return res.status(401).json({ error: "unauthorized" });

    const messages = Array.isArray(req.body?.messages)
      ? req.body.messages
      : [];
    let reply = "";
    try {
      reply = await runLiveTurn(userId, messages);
    } catch (e) {
      console.error("live turn failed:", e.message);
      reply = "Sorry, something went wrong on my side just now.";
    }

    const id = "chatcmpl-live-" + Date.now();
    const model = req.body?.model || "myassistant-agent";
    if (req.body?.stream) {
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const chunk = (delta, finish = null) =>
        res.write(
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
      chunk({ role: "assistant" });
      // Stream in sentence-ish pieces so TTS can start promptly.
      for (const piece of reply.match(/[^.!?\n]+[.!?\n]?\s*/g) || [reply]) {
        chunk({ content: piece });
      }
      chunk({}, "stop");
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    res.json({
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: reply },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }
);

module.exports = {
  router,
  runLiveTurn, // exported for tests
  queueDeviceAction,
  attachActionListener,
  detachActionListener,
  ackAction,
  _pendingConfirm: pendingConfirm,
};
