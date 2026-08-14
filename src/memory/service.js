/**
 * MEMORY SERVICE — structured entities + typed memories + hybrid recall.
 *
 * Every function takes userId FIRST and every query filters on it. The
 * caller must pass the id derived from the verified session, never one
 * supplied by the client (§11). `assertUser` makes a missing id a loud
 * failure rather than a silent cross-tenant read.
 *
 * Retrieval is deliberately NOT vector-only (§7). `recallAbout()` runs, in
 * order: structured entity lookup → linked cases/documents/events → notes
 * → semantic memory ranking. Vector similarity only ranks the fact list;
 * it never decides who "Ravi" is.
 */
const { query, one, run } = require("../db");

const now = () => Date.now();

function assertUser(userId) {
  const id = Number(userId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error("memory: authenticated userId required");
  }
  return id;
}

/* ------------------------------------------------------------------ */
/* People                                                              */
/* ------------------------------------------------------------------ */

async function upsertPerson(userId, { name, relationship, organisation, location, kind, summary }) {
  const uid = assertUser(userId);
  const nm = String(name || "").trim();
  if (!nm) throw new Error("person name required");

  const existing = await one(
    `SELECT * FROM clients WHERE user_id=$1 AND lower(name)=lower($2) LIMIT 1`,
    [uid, nm]
  );
  const t = now();
  if (existing) {
    // Update only what was supplied — a later mention must not blank out
    // details learned earlier.
    await run(
      `UPDATE clients SET
         relationship = COALESCE(NULLIF($3,''), relationship),
         organisation = COALESCE(NULLIF($4,''), organisation),
         location     = COALESCE(NULLIF($5,''), location),
         kind         = COALESCE(NULLIF($6,''), kind),
         summary      = COALESCE(NULLIF($7,''), summary),
         archived     = 0,
         updated_at   = $8
       WHERE user_id=$1 AND id=$2`,
      [uid, existing.id, relationship || "", organisation || "", location || "",
       kind || "", summary || "", t]
    );
    return { ...existing, id: existing.id, created: false };
  }
  const row = await one(
    `INSERT INTO clients
       (user_id,name,kind,relationship,organisation,location,summary,phone,email,tags,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'','','',$8,$8) RETURNING *`,
    [uid, nm, kind || "other", relationship || "", organisation || "",
     location || "", summary || "", t]
  );
  return { ...row, created: true };
}

async function findPerson(userId, name) {
  const uid = assertUser(userId);
  const nm = String(name || "").trim();
  if (!nm) return null;
  return (
    (await one(
      `SELECT * FROM clients
        WHERE user_id=$1 AND archived=0 AND lower(name)=lower($2) LIMIT 1`,
      [uid, nm]
    )) ||
    // Fall back to a prefix match so "Ravi" finds "Ravi Kumar".
    (await one(
      `SELECT * FROM clients
        WHERE user_id=$1 AND archived=0 AND lower(name) LIKE lower($2)||'%'
        ORDER BY updated_at DESC LIMIT 1`,
      [uid, nm]
    ))
  );
}

/* ------------------------------------------------------------------ */
/* Cases                                                               */
/* ------------------------------------------------------------------ */

async function upsertCase(userId, { title, kind, status, description, location, personId }) {
  const uid = assertUser(userId);
  const ti = String(title || "").trim();
  if (!ti) throw new Error("case title required");
  const t = now();

  let row = await one(
    `SELECT * FROM cases WHERE user_id=$1 AND lower(title)=lower($2) LIMIT 1`,
    [uid, ti]
  );
  if (row) {
    await run(
      `UPDATE cases SET
         kind        = COALESCE(NULLIF($3,''), kind),
         status      = COALESCE(NULLIF($4,''), status),
         description = COALESCE(NULLIF($5,''), description),
         location    = COALESCE(NULLIF($6,''), location),
         updated_at  = $7
       WHERE user_id=$1 AND id=$2`,
      [uid, row.id, kind || "", status || "", description || "", location || "", t]
    );
  } else {
    row = await one(
      `INSERT INTO cases (user_id,title,kind,status,description,location,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`,
      [uid, ti, kind || "case", status || "open", description || "", location || "", t]
    );
  }
  if (personId) await linkCasePerson(uid, row.id, personId);
  return row;
}

async function linkCasePerson(userId, caseId, personId, role = "") {
  const uid = assertUser(userId);
  await run(
    `INSERT INTO case_people (user_id,case_id,person_id,role)
     VALUES ($1,$2,$3,$4) ON CONFLICT (case_id,person_id) DO NOTHING`,
    [uid, caseId, personId, role]
  );
}

async function casesForPerson(userId, personId) {
  const uid = assertUser(userId);
  return query(
    `SELECT c.* FROM cases c
       JOIN case_people cp ON cp.case_id=c.id AND cp.user_id=c.user_id
      WHERE c.user_id=$1 AND cp.person_id=$2
      ORDER BY c.updated_at DESC`,
    [uid, personId]
  );
}

/* ------------------------------------------------------------------ */
/* Documents (many-to-many)                                            */
/* ------------------------------------------------------------------ */

async function linkDocument(userId, documentId, entityType, entityId) {
  const uid = assertUser(userId);
  if (!["person", "case"].includes(entityType)) {
    throw new Error("entityType must be person|case");
  }
  // Ownership check: never link a document the user doesn't own.
  const doc = await one(`SELECT id FROM documents WHERE user_id=$1 AND id=$2`, [
    uid, documentId,
  ]);
  if (!doc) throw new Error("document not found");
  await run(
    `INSERT INTO document_links (user_id,document_id,entity_type,entity_id,created_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (document_id,entity_type,entity_id) DO NOTHING`,
    [uid, documentId, entityType, entityId, now()]
  );
}

async function documentsFor(userId, entityType, entityId) {
  const uid = assertUser(userId);
  // Union of the new many-to-many links and the legacy documents.client_id,
  // so documents attached before this migration still appear.
  return query(
    `SELECT DISTINCT d.* FROM documents d
       LEFT JOIN document_links l
         ON l.document_id=d.id AND l.user_id=d.user_id
      WHERE d.user_id=$1
        AND ( (l.entity_type=$2 AND l.entity_id=$3)
              OR ($2='person' AND d.client_id=$3) )
      ORDER BY d.created_at DESC`,
    [uid, entityType, entityId]
  );
}

/* ------------------------------------------------------------------ */
/* Memories: write, correct, forget                                    */
/* ------------------------------------------------------------------ */

async function remember(userId, {
  fact, kind = "semantic", subjectType = "", subjectId = null,
  importance = 3, confidence = 0.8, source = "conversation", sourceRef = "",
  embedding = null,
}) {
  const uid = assertUser(userId);
  const text = String(fact || "").trim();
  if (!text) throw new Error("fact required");

  // CORRECTION over accumulation (§10): a new fact about the same subject
  // that restates the same attribute supersedes the old one rather than
  // sitting beside it contradicting it.
  if (subjectType && subjectId) {
    const key = attributeKey(text);
    if (key) {
      const clash = await query(
        `SELECT id, fact FROM agent_memories
          WHERE user_id=$1 AND valid=1 AND subject_type=$2 AND subject_id=$3`,
        [uid, subjectType, subjectId]
      );
      for (const m of clash) {
        if (attributeKey(m.fact) === key) {
          await run(
            `UPDATE agent_memories SET valid=0, invalidated_at=$3, updated_at=$3
              WHERE user_id=$1 AND id=$2`,
            [uid, m.id, now()]
          );
        }
      }
    }
  }

  return one(
    `INSERT INTO agent_memories
       (user_id,fact,importance,created_at,kind,subject_type,subject_id,
        source,source_ref,confidence,valid,updated_at,embedding)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$4,$11) RETURNING *`,
    [uid, text, importance, now(), kind, subjectType, subjectId, source,
     sourceRef, confidence, embedding ? JSON.stringify(embedding) : null]
  );
}

/**
 * Which attribute a fact is about, so a restatement supersedes rather than
 * duplicates ("hearing is Sept 3" then "hearing moved to Sept 9").
 * Coarse on purpose: better to keep two facts than to wrongly delete one.
 */
function attributeKey(fact) {
  const f = String(fact).toLowerCase();
  const keys = [
    "hearing", "address", "phone", "email", "birthday", "anniversary",
    "salary", "designation", "company", "organisation", "relationship",
  ];
  return keys.find((k) => f.includes(k)) || null;
}

/**
 * Invalidates memories (§10). Soft delete keeps an audit trail while
 * removing the fact from every retrieval path. Returns how many.
 */
async function forget(userId, { subjectType = "", subjectId = null, match = "" }) {
  const uid = assertUser(userId);
  const m = String(match || "").trim();
  const rows = await query(
    `SELECT id, fact FROM agent_memories
      WHERE user_id=$1 AND valid=1
        AND ($2='' OR subject_type=$2)
        AND ($3::bigint IS NULL OR subject_id=$3)`,
    [uid, subjectType, subjectId]
  );
  const hits = m
    ? rows.filter((r) => {
        const f = r.fact.toLowerCase();
        return m
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 2)
          .some((w) => f.includes(w));
      })
    : rows;
  for (const h of hits) {
    await run(
      `UPDATE agent_memories SET valid=0, invalidated_at=$3, updated_at=$3
        WHERE user_id=$1 AND id=$2`,
      [uid, h.id, now()]
    );
  }
  return hits.length;
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

async function addEvent(userId, { title, whenAt = null, subjectType = "", subjectId = null, notes = "" }) {
  const uid = assertUser(userId);
  return one(
    `INSERT INTO events (user_id,title,when_at,subject_type,subject_id,notes,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [uid, String(title).trim(), whenAt, subjectType, subjectId, notes, now()]
  );
}

async function eventsFor(userId, subjectType, subjectId) {
  const uid = assertUser(userId);
  return query(
    `SELECT * FROM events
      WHERE user_id=$1 AND subject_type=$2 AND subject_id=$3
      ORDER BY when_at NULLS LAST, id DESC`,
    [uid, subjectType, subjectId]
  );
}

/* ------------------------------------------------------------------ */
/* Hybrid retrieval                                                    */
/* ------------------------------------------------------------------ */

/** Cosine similarity of two equal-length vectors. */
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Everything known about a person: the structured record, their cases,
 * linked documents, dated events, notes and valid memories.
 * This is what answers "What do you know about Ravi?".
 */
async function recallAbout(userId, name) {
  const uid = assertUser(userId);
  const person = await findPerson(uid, name);
  if (!person) return null;

  const [cases, docs, evts, notes, mems] = await Promise.all([
    casesForPerson(uid, person.id),
    documentsFor(uid, "person", person.id),
    eventsFor(uid, "person", person.id),
    query(
      `SELECT text, created_at FROM client_notes
        WHERE user_id=$1 AND client_id=$2 ORDER BY id DESC LIMIT 20`,
      [uid, person.id]
    ),
    query(
      `SELECT fact, kind, confidence, created_at FROM agent_memories
        WHERE user_id=$1 AND valid=1 AND subject_type='person' AND subject_id=$2
        ORDER BY importance DESC, id DESC LIMIT 30`,
      [uid, person.id]
    ),
  ]);

  // Documents attached to the person's cases count as the person's too.
  const caseDocs = [];
  for (const c of cases) {
    caseDocs.push(...(await documentsFor(uid, "case", c.id)));
  }
  const allDocs = dedupeById([...docs, ...caseDocs]);
  const caseEvents = [];
  for (const c of cases) {
    caseEvents.push(...(await eventsFor(uid, "case", c.id)));
  }

  return {
    person: {
      id: person.id, name: person.name, kind: person.kind,
      relationship: person.relationship, organisation: person.organisation,
      location: person.location, summary: person.summary,
    },
    cases: cases.map((c) => ({
      id: c.id, title: c.title, kind: c.kind, status: c.status,
      description: c.description, location: c.location,
    })),
    documents: allDocs.map((d) => ({ id: d.id, title: d.title || d.filename, category: d.category })),
    events: [...evts, ...caseEvents].map((e) => ({ title: e.title, when_at: e.when_at, notes: e.notes })),
    notes: notes.map((n) => n.text),
    facts: mems.map((m) => m.fact),
  };
}

function dedupeById(list) {
  const seen = new Set();
  return list.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

/**
 * General recall for a free-text question. Structured first, semantic to
 * rank the remainder — never vector-only.
 */
async function search(userId, queryText, { embedding = null, limit = 12 } = {}) {
  const uid = assertUser(userId);
  const q = String(queryText || "").trim();

  // 1. Structured: does the question name a known person or case?
  const words = q.split(/\s+/).filter((w) => w.length > 2).slice(0, 8);
  const people = words.length
    ? await query(
        `SELECT * FROM clients
          WHERE user_id=$1 AND archived=0 AND lower(name) = ANY($2::text[])
          LIMIT 5`,
        [uid, words.map((w) => w.toLowerCase())]
      )
    : [];

  // 2. Candidate facts, narrowed by subject when we matched an entity.
  const rows = people.length
    ? await query(
        `SELECT * FROM agent_memories
          WHERE user_id=$1 AND valid=1
            AND (subject_id = ANY($2::bigint[]) OR subject_type='')
          ORDER BY importance DESC, id DESC LIMIT 200`,
        [uid, people.map((p) => p.id)]
      )
    : await query(
        `SELECT * FROM agent_memories
          WHERE user_id=$1 AND valid=1
          ORDER BY importance DESC, id DESC LIMIT 200`,
        [uid]
      );

  // 3. Rank: cosine when an embedding is available, lexical overlap
  //    otherwise, so recall still works with no embedding provider.
  const scored = rows.map((r) => {
    let score = 0;
    if (embedding && r.embedding) {
      const v = typeof r.embedding === "string" ? JSON.parse(r.embedding) : r.embedding;
      score = cosine(embedding, v);
    } else {
      const f = r.fact.toLowerCase();
      score = words.reduce((n, w) => n + (f.includes(w.toLowerCase()) ? 1 : 0), 0) /
        Math.max(1, words.length);
    }
    return { fact: r.fact, kind: r.kind, score };
  });
  scored.sort((a, b) => b.score - a.score);

  return {
    people: people.map((p) => ({ id: p.id, name: p.name, relationship: p.relationship })),
    facts: scored.filter((s) => s.score > 0).slice(0, limit),
  };
}

/* ------------------------------------------------------------------ */
/* Conversation history (episodic)                                     */
/* ------------------------------------------------------------------ */

async function startConversation(userId, channel = "voice") {
  const uid = assertUser(userId);
  return one(
    `INSERT INTO conversations (user_id,channel,started_at) VALUES ($1,$2,$3) RETURNING *`,
    [uid, channel, now()]
  );
}

async function addMessage(userId, conversationId, role, content) {
  const uid = assertUser(userId);
  return one(
    `INSERT INTO messages (user_id,conversation_id,role,content,created_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [uid, conversationId, role, String(content).slice(0, 4000), now()]
  );
}

module.exports = {
  upsertPerson, findPerson,
  upsertCase, linkCasePerson, casesForPerson,
  linkDocument, documentsFor,
  remember, forget, attributeKey,
  addEvent, eventsFor,
  recallAbout, search, cosine,
  startConversation, addMessage,
  assertUser,
};
