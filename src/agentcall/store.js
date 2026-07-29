/**
 * AGENT CALL STORE
 * ----------------
 * One row per outbound "AI talks on the phone" call:
 *   "call Allen and ask him what time he'll be home"
 * The row carries the task, the running transcript (agent + contact
 * turns), and the final result summary the app speaks back to the user.
 */
const crypto = require("crypto");
const { db } = require("../db");

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_calls (
    id           TEXT PRIMARY KEY,            -- opaque, unguessable
    user_id      TEXT NOT NULL,
    contact_name TEXT NOT NULL,
    to_number    TEXT NOT NULL,               -- E.164
    task         TEXT NOT NULL,               -- what to ask / tell
    lang         TEXT NOT NULL DEFAULT 'en-IN',
    state        TEXT NOT NULL DEFAULT 'queued',
      -- queued | dialing | in_progress | completed | no_answer | failed
    transcript   TEXT NOT NULL DEFAULT '[]',  -- JSON [{who:'agent'|'contact', text}]
    result       TEXT,                        -- summary spoken back to the user
    twilio_sid   TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_calls_user
    ON agent_calls (user_id, created_at DESC);
`);

const stmts = {
  insert: db.prepare(`
    INSERT INTO agent_calls
      (id, user_id, contact_name, to_number, task, lang, state, created_at, updated_at)
    VALUES (@id, @user_id, @contact_name, @to_number, @task, @lang, 'queued', @now, @now)
  `),
  byId: db.prepare("SELECT * FROM agent_calls WHERE id = ?"),
  setState: db.prepare(
    "UPDATE agent_calls SET state = ?, updated_at = ? WHERE id = ?"
  ),
  setSid: db.prepare(
    "UPDATE agent_calls SET twilio_sid = ?, updated_at = ? WHERE id = ?"
  ),
  setTranscript: db.prepare(
    "UPDATE agent_calls SET transcript = ?, updated_at = ? WHERE id = ?"
  ),
  setResult: db.prepare(
    "UPDATE agent_calls SET result = ?, state = ?, updated_at = ? WHERE id = ?"
  ),
};

function create({ userId, contactName, toNumber, task, lang }) {
  const id = crypto.randomBytes(16).toString("hex");
  stmts.insert.run({
    id,
    user_id: String(userId),
    contact_name: contactName,
    to_number: toNumber,
    task,
    lang: lang || "en-IN",
    now: Date.now(),
  });
  return get(id);
}

function get(id) {
  const row = stmts.byId.get(id);
  if (!row) return null;
  return { ...row, transcript: safeParse(row.transcript) };
}

function safeParse(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

function setState(id, state) {
  stmts.setState.run(state, Date.now(), id);
}

function setTwilioSid(id, sid) {
  stmts.setSid.run(sid, Date.now(), id);
}

/** Appends one turn and returns the updated transcript array. */
function addTurn(id, who, text) {
  const call = get(id);
  if (!call) return [];
  const t = call.transcript;
  t.push({ who, text: String(text || "").slice(0, 1000) });
  stmts.setTranscript.run(JSON.stringify(t), Date.now(), id);
  return t;
}

function setResult(id, result, state = "completed") {
  stmts.setResult.run(result, state, Date.now(), id);
}

/** Terminal states — polling can stop. */
const DONE = new Set(["completed", "no_answer", "failed"]);
const isDone = (state) => DONE.has(state);

module.exports = { create, get, setState, setTwilioSid, addTurn, setResult, isDone };
