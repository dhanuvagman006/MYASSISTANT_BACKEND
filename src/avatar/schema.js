/**
 * AVATAR PERSISTENCE (Re-architecture §3–§6, §18–§20) — the tables that
 * make the live video assistant the SAME persistent assistant every day.
 *
 *   avatar_personas     one Tavus persona per user whose LLM layer points
 *                       back at THIS server (/avatar/llm). The api_key is
 *                       the per-user bearer secret Tavus presents, which
 *                       is how a live utterance is mapped to an
 *                       authenticated user (§3).
 *
 *   avatar_sessions     every live conversation minted, so provider
 *                       webhooks (transcripts) can be mapped back to the
 *                       owning user. The session is temporary; the rows
 *                       let its content flow into persistent memory (§20).
 *
 *   conversation_state  one rolling recent-conversation window per user
 *                       (§19): compact recent turns injected into the
 *                       next session so "as I said yesterday…" works
 *                       without replaying a lifetime transcript.
 */
async function migrate(exec) {
  await exec(`
    CREATE TABLE IF NOT EXISTS avatar_personas (
      user_id    INTEGER PRIMARY KEY,
      persona_id TEXT NOT NULL,
      api_key    TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_avatar_personas_key
      ON avatar_personas(api_key);

    CREATE TABLE IF NOT EXISTS avatar_sessions (
      conversation_id TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      started_at BIGINT NOT NULL,
      ended_at   BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_avatar_sessions_user
      ON avatar_sessions(user_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS conversation_state (
      user_id    INTEGER PRIMARY KEY,
      summary    TEXT NOT NULL DEFAULT '',
      updated_at BIGINT NOT NULL
    );
  `);
}

module.exports = { migrate };
