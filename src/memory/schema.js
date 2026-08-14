/**
 * PHASE 2 SCHEMA — entity + memory model.
 *
 * DESIGN NOTE (why there is no new "people" table):
 * `clients` is ALREADY a generic person entity — it carries
 * kind = patient|client|student|customer|other, plus phone/email/summary/
 * tags, has `client_notes` for dated notes and `documents.client_id` for a
 * document link. Creating a parallel `people` table would have produced two
 * competing person stores and orphaned every existing row. So `clients` IS
 * the people table; this migration widens it (relationship, organisation,
 * location) and adds the pieces it lacks: cases, many-to-many document
 * links, typed/invalidatable memories, conversation messages and events.
 *
 * VECTORS WITHOUT pgvector:
 * The stock postgres:16-alpine image has no `vector` extension, and
 * requiring it would break deployment. Embeddings are stored as JSONB
 * float arrays and ranked by cosine in Node over a per-user candidate set
 * that is FIRST narrowed by structured filters (user, entity, kind), so
 * the vector scan is bounded and fast. If the extension is present the
 * same rows can be migrated to a `vector` column later without changing
 * the retrieval API.
 *
 * TENANT ISOLATION: every table here carries user_id NOT NULL and every
 * index leads with it. The repository layer takes userId from the verified
 * session, never from the client (§11).
 */

async function migrate(exec) {
  await exec(`
    -- ---------- PEOPLE (widened clients) ----------
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS relationship TEXT NOT NULL DEFAULT '';
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS organisation TEXT NOT NULL DEFAULT '';
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS location     TEXT NOT NULL DEFAULT '';
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS archived     INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS idx_clients_name
      ON clients(user_id, lower(name));

    -- ---------- CASES (generic: legal case, project, medical record…) ----
    CREATE TABLE IF NOT EXISTS cases (
      id          BIGSERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      title       TEXT NOT NULL,
      kind        TEXT NOT NULL DEFAULT 'case',   -- case|project|matter|record|other
      status      TEXT NOT NULL DEFAULT 'open',   -- open|closed|on_hold
      description TEXT NOT NULL DEFAULT '',
      location    TEXT NOT NULL DEFAULT '',
      created_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cases_user ON cases(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cases_title ON cases(user_id, lower(title));

    -- A case involves people (many-to-many: co-parties, opposing counsel…).
    CREATE TABLE IF NOT EXISTS case_people (
      user_id   INTEGER NOT NULL,
      case_id   BIGINT  NOT NULL,
      person_id BIGINT  NOT NULL,
      role      TEXT    NOT NULL DEFAULT '',
      PRIMARY KEY (case_id, person_id)
    );
    CREATE INDEX IF NOT EXISTS idx_case_people_user
      ON case_people(user_id, person_id);

    -- ---------- DOCUMENT LINKS (a doc may belong to MANY entities) -------
    -- documents.client_id stays for backward compatibility; new links go
    -- here so one court notice can belong to a person AND a case.
    CREATE TABLE IF NOT EXISTS document_links (
      user_id     INTEGER NOT NULL,
      document_id BIGINT  NOT NULL,
      entity_type TEXT    NOT NULL,   -- 'person' | 'case'
      entity_id   BIGINT  NOT NULL,
      created_at  BIGINT  NOT NULL,
      PRIMARY KEY (document_id, entity_type, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_doclinks_entity
      ON document_links(user_id, entity_type, entity_id);

    -- ---------- MEMORIES (typed, sourced, correctable) -------------------
    -- Extends the existing agent_memories rather than replacing it, so the
    -- facts already learned about the user survive the upgrade.
    ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'semantic';
      -- semantic | episodic | relationship | preference | task
    ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS subject_type TEXT NOT NULL DEFAULT '';
      -- '' | 'person' | 'case'
    ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS subject_id BIGINT;
    ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'conversation';
    ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS source_ref TEXT NOT NULL DEFAULT '';
    ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS confidence REAL NOT NULL DEFAULT 0.8;
    ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS valid INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS invalidated_at BIGINT;
    ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS updated_at BIGINT;
    ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS embedding JSONB;
    CREATE INDEX IF NOT EXISTS idx_memories_subject
      ON agent_memories(user_id, subject_type, subject_id) WHERE valid = 1;
    CREATE INDEX IF NOT EXISTS idx_memories_valid
      ON agent_memories(user_id, valid, importance DESC, id DESC);

    -- ---------- EVENTS (dated things: hearings, meetings, deadlines) -----
    CREATE TABLE IF NOT EXISTS events (
      id           BIGSERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL,
      title        TEXT NOT NULL,
      when_at      BIGINT,
      subject_type TEXT NOT NULL DEFAULT '',   -- '' | 'person' | 'case'
      subject_id   BIGINT,
      notes        TEXT NOT NULL DEFAULT '',
      created_at   BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, when_at);
    CREATE INDEX IF NOT EXISTS idx_events_subject
      ON events(user_id, subject_type, subject_id);

    -- ---------- CONVERSATION HISTORY (episodic source of truth) ----------
    CREATE TABLE IF NOT EXISTS conversations (
      id         BIGSERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      channel    TEXT NOT NULL DEFAULT 'voice',  -- voice | live | text | avatar
      started_at BIGINT NOT NULL,
      summary    TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, id DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id              BIGSERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL,
      conversation_id BIGINT NOT NULL,
      role            TEXT NOT NULL,             -- user | assistant
      content         TEXT NOT NULL,
      created_at      BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(user_id, conversation_id, id);
  `);
}

module.exports = { migrate };
