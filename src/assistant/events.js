/**
 * ASSISTANT EVENT HUB — session registry + Server-Sent Events stream.
 *
 * One assistant "session" per app launch (the app creates it, then opens
 * GET /assistant/stream/:id as an EventSource). Every state change, tool
 * start, search result, call update etc. is pushed as one JSON event:
 *
 *   { "type": "assistant_state", "state": "searching" }
 *   { "type": "tool_started", "tool": "search_web", "label": "Searching the web" }
 *   { "type": "call_status", "status": "dialing", "contact_name": "Alan" }
 *
 * Sessions are in-memory (single-process). Events emitted while the SSE
 * socket is briefly disconnected are buffered (last 100) and replayed on
 * reconnect via the Last-Event-ID header, so the UI never misses a state.
 */
const crypto = require("crypto");

const SESSION_TTL_MS = 30 * 60_000; // idle sessions die after 30 min
const BUFFER_MAX = 100;

/** @type {Map<string, Session>} */
const sessions = new Map();

class Session {
  constructor(userId) {
    this.id = crypto.randomBytes(16).toString("hex");
    this.userId = String(userId);
    this.createdAt = Date.now();
    this.lastSeen = Date.now();
    this.res = null; // live SSE response, when connected
    this.buffer = []; // [{seq, payload}] replay buffer
    this.seq = 0;
    this.state = "idle";
    // Orchestration context (set by orchestrator):
    this.history = []; // chat turns [{role, content}]
    this.pending = null; // pending confirmation / contact lookup
    this.activeCallId = null;
    this.cancelled = false;
  }

  attach(res, lastEventId) {
    this.res = res;
    this.lastSeen = Date.now();
    // Replay anything the client missed while reconnecting.
    const after = Number(lastEventId) || 0;
    for (const e of this.buffer) {
      if (e.seq > after) this.write(e.seq, e.payload);
    }
  }

  detach(res) {
    if (this.res === res) this.res = null;
  }

  write(seq, payload) {
    if (!this.res) return;
    try {
      this.res.write(`id: ${seq}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch (_) {
      this.res = null;
    }
  }

  emit(payload) {
    this.lastSeen = Date.now();
    const seq = ++this.seq;
    this.buffer.push({ seq, payload });
    if (this.buffer.length > BUFFER_MAX) this.buffer.shift();
    if (payload.type === "assistant_state") this.state = payload.state;
    this.write(seq, payload);
  }

  /** Convenience: state event. */
  setState(state, extra = {}) {
    this.emit({ type: "assistant_state", state, ...extra });
  }
}

function create(userId) {
  const s = new Session(userId);
  sessions.set(s.id, s);
  return s;
}

function get(id, userId) {
  const s = sessions.get(String(id || ""));
  if (!s) return null;
  if (userId !== undefined && s.userId !== String(userId)) return null;
  s.lastSeen = Date.now();
  return s;
}

function destroy(id) {
  const s = sessions.get(id);
  if (s?.res) {
    try {
      s.res.end();
    } catch (_) {}
  }
  sessions.delete(id);
}

// Reap idle sessions so a long-running process doesn't leak memory.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastSeen > SESSION_TTL_MS) destroy(id);
  }
}, 60_000).unref();

module.exports = { create, get, destroy };
