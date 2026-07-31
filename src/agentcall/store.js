/**
 * AGENT CALL STORE (Postgres)
 * ---------------------------
 * One row per outbound "AI talks on the phone" call. The row carries the
 * task, the running transcript (agent + contact turns), and the final
 * result summary the app speaks back to the user.
 * Schema lives in src/db.js init().
 */
const crypto = require("crypto");
const { one, run } = require("../db");

const DEFAULT_SETTINGS = { enabled: 1, daily_limit: 10, hours_start: 8, hours_end: 21 };

/** G2 — the user's calling rules (defaults until they change them). */
async function getSettings(userId) {
  const row = await one(
    "SELECT * FROM agent_call_settings WHERE user_id = $1",
    [String(userId)]
  );
  return row || { user_id: String(userId), ...DEFAULT_SETTINGS };
}

async function setSettings(userId, patch) {
  const cur = await getSettings(userId);
  const next = {
    enabled: patch.enabled === undefined ? cur.enabled : patch.enabled ? 1 : 0,
    daily_limit: clampInt(patch.daily_limit, 0, 50, cur.daily_limit),
    hours_start: clampInt(patch.hours_start, 0, 23, cur.hours_start),
    hours_end: clampInt(patch.hours_end, 1, 24, cur.hours_end),
  };
  await run(
    `INSERT INTO agent_call_settings (user_id, enabled, daily_limit, hours_start, hours_end)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET
       enabled = EXCLUDED.enabled, daily_limit = EXCLUDED.daily_limit,
       hours_start = EXCLUDED.hours_start, hours_end = EXCLUDED.hours_end`,
    [String(userId), next.enabled, next.daily_limit, next.hours_start, next.hours_end]
  );
  return getSettings(userId);
}

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isInteger(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

/** Calls placed since the user's local midnight (tzOffset minutes east of UTC). */
async function countToday(userId, tzOffsetMin = 330) {
  const nowLocal = Date.now() + tzOffsetMin * 60_000;
  const midnightUtc = Math.floor(nowLocal / 864e5) * 864e5 - tzOffsetMin * 60_000;
  const row = await one(
    `SELECT COUNT(*)::int AS n FROM agent_calls
     WHERE user_id = $1 AND created_at >= $2 AND state != 'blocked'`,
    [String(userId), midnightUtc]
  );
  return row.n;
}

async function create({ userId, contactName, toNumber, task, lang }) {
  const id = crypto.randomBytes(16).toString("hex");
  const now = Date.now();
  await run(
    `INSERT INTO agent_calls
       (id, user_id, contact_name, to_number, task, lang, state, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $7)`,
    [id, String(userId), contactName, toNumber, task, lang || "en-IN", now]
  );
  return get(id);
}

async function get(id) {
  const row = await one("SELECT * FROM agent_calls WHERE id = $1", [id]);
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

async function setState(id, state) {
  await run("UPDATE agent_calls SET state = $1, updated_at = $2 WHERE id = $3", [
    state, Date.now(), id,
  ]);
}

async function setProviderId(id, providerId) {
  await run(
    "UPDATE agent_calls SET provider_call_id = $1, updated_at = $2 WHERE id = $3",
    [providerId, Date.now(), id]
  );
}

/** Appends one turn and returns the updated transcript array. */
async function addTurn(id, who, text) {
  const call = await get(id);
  if (!call) return [];
  const t = call.transcript;
  t.push({ who, text: String(text || "").slice(0, 1000) });
  await run(
    "UPDATE agent_calls SET transcript = $1, updated_at = $2 WHERE id = $3",
    [JSON.stringify(t), Date.now(), id]
  );
  return t;
}

async function setResult(id, result, state = "completed") {
  await run(
    "UPDATE agent_calls SET result = $1, state = $2, updated_at = $3 WHERE id = $4",
    [result, state, Date.now(), id]
  );
}

/** Terminal states — polling can stop. */
const DONE = new Set(["completed", "no_answer", "failed"]);
const isDone = (state) => DONE.has(state);

module.exports = {
  getSettings, setSettings, countToday, create, get, setState, setProviderId, addTurn, setResult, isDone };
