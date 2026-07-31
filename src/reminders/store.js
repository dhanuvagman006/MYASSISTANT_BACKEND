/**
 * PER-USER REMINDERS (Postgres)
 * -----------------------------
 * Created two ways: voice ("remind me to call amma tomorrow at 5" via the
 * intent layer in /chat) and the Today screen's + button. The app syncs
 * this list and schedules local notifications for every future due_at.
 * Schema lives in src/db.js init().
 */
const { query, one, run } = require("../db");

async function list(userId) {
  return query(
    `SELECT * FROM reminders WHERE user_id = $1
     ORDER BY done ASC, due_at ASC NULLS LAST, created_at DESC LIMIT 200`,
    [userId]
  );
}

async function create(userId, text, dueAt = null) {
  const t = String(text || "").trim().slice(0, 300);
  if (!t) return null;
  return one(
    "INSERT INTO reminders (user_id, text, due_at, created_at) VALUES ($1, $2, $3, $4) RETURNING *",
    [userId, t, dueAt || null, Date.now()]
  );
}

async function setDone(userId, id, done) {
  return (await run(
    "UPDATE reminders SET done = $1 WHERE user_id = $2 AND id = $3",
    [done ? 1 : 0, userId, id]
  )) > 0;
}

async function update(userId, id, text, dueAt) {
  const cur = await one("SELECT * FROM reminders WHERE user_id = $1 AND id = $2", [userId, id]);
  if (!cur) return null;
  return one(
    "UPDATE reminders SET text = $1, due_at = $2 WHERE user_id = $3 AND id = $4 RETURNING *",
    [
      text != null ? String(text).trim().slice(0, 300) : cur.text,
      dueAt !== undefined ? dueAt : cur.due_at,
      userId,
      id,
    ]
  );
}

async function remove(userId, id) {
  return (await run("DELETE FROM reminders WHERE user_id = $1 AND id = $2", [userId, id])) > 0;
}

/** Compact upcoming list for AI context / spoken briefings. */
async function upcomingText(userId, { max = 8 } = {}) {
  const rows = (await list(userId)).filter((r) => !r.done).slice(0, max);
  if (rows.length === 0) return "";
  return rows
    .map((r) => {
      const when = r.due_at ? new Date(r.due_at).toISOString() : "no set time";
      return `- [id ${r.id}] ${r.text} (due ${when})`;
    })
    .join("\n");
}

module.exports = { list, create, setDone, update, remove, upcomingText };
