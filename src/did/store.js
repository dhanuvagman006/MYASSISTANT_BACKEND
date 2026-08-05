/**
 * D-ID STORE — which D-ID agent belongs to which user (per mode), and
 * the daily briefing video cache (one video per user per day).
 *
 * Tables are created lazily here (idempotent) so the module is fully
 * self-contained and drops out cleanly if the feature is disabled.
 */
const { query, one, run } = require("../db");

let ready = null;
function ensure() {
  if (!ready) {
    ready = (async () => {
      await run(`
        CREATE TABLE IF NOT EXISTS did_agents (
          user_id    INTEGER NOT NULL,
          mode       TEXT NOT NULL DEFAULT 'assistant',  -- assistant | interview
          agent_id   TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          PRIMARY KEY (user_id, mode)
        )`);
      await run(`
        CREATE TABLE IF NOT EXISTS did_briefings (
          user_id    INTEGER NOT NULL,
          day        TEXT NOT NULL,                      -- YYYY-MM-DD (user's tz)
          talk_id    TEXT,
          status     TEXT NOT NULL DEFAULT 'creating',   -- creating | processing | done | error
          result_url TEXT,
          script     TEXT,
          created_at BIGINT NOT NULL,
          PRIMARY KEY (user_id, day)
        )`);
    })();
  }
  return ready;
}

async function getAgent(userId, mode) {
  await ensure();
  return one(`SELECT agent_id FROM did_agents WHERE user_id=$1 AND mode=$2`, [userId, mode]);
}

async function saveAgent(userId, mode, agentId) {
  await ensure();
  await run(
    `INSERT INTO did_agents (user_id, mode, agent_id, created_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, mode) DO UPDATE SET agent_id=EXCLUDED.agent_id, created_at=EXCLUDED.created_at`,
    [userId, mode, agentId, Date.now()]
  );
}

async function deleteAgents(userId) {
  await ensure();
  const rows = await query(`SELECT agent_id FROM did_agents WHERE user_id=$1`, [userId]);
  await run(`DELETE FROM did_agents WHERE user_id=$1`, [userId]);
  return rows.map((r) => r.agent_id);
}

async function getBriefing(userId, day) {
  await ensure();
  return one(`SELECT * FROM did_briefings WHERE user_id=$1 AND day=$2`, [userId, day]);
}

async function upsertBriefing(userId, day, fields) {
  await ensure();
  const cur = (await getBriefing(userId, day)) || {};
  const next = { ...cur, ...fields };
  await run(
    `INSERT INTO did_briefings (user_id, day, talk_id, status, result_url, script, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (user_id, day) DO UPDATE SET
       talk_id=EXCLUDED.talk_id, status=EXCLUDED.status,
       result_url=EXCLUDED.result_url, script=EXCLUDED.script`,
    [
      userId,
      day,
      next.talk_id || null,
      next.status || "creating",
      next.result_url || null,
      next.script || null,
      cur.created_at || Date.now(),
    ]
  );
  return getBriefing(userId, day);
}

module.exports = { getAgent, saveAgent, deleteAgents, getBriefing, upsertBriefing };
