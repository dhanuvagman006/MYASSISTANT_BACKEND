/**
 * DOCUMENT INTELLIGENCE (§16, §18).
 *
 *   Upload → (existing) OCR/extract → classify → CHUNK → EMBED →
 *   entity/case association → retrieval
 *
 * The OCR/extraction and classification steps already existed
 * (docs/analyze.js writes full_text, title, category, summary). This module
 * adds what was missing: chunking, embeddings and — the important part —
 * ENTITY-SCOPED retrieval.
 *
 * §18 is explicit that "find Ravi's court notice" must NOT be a blind
 * global vector search. `findDocuments()` therefore resolves the person and
 * their cases FIRST and searches only inside that set, falling back to the
 * user's whole library only when no entity is named. Semantic similarity
 * ranks candidates; it never selects them.
 *
 * Embeddings are optional throughout: with no provider configured, chunks
 * are still stored and retrieval ranks lexically (§17).
 */
const { query, one, run } = require("../db");
const embeddings = require("../memory/embeddings");
const mem = require("../memory/service");

const MAX_CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 150;
const MAX_CHUNKS_PER_DOC = 80; // a 100-page scan must not blow up the DB

async function migrate(exec) {
  await exec(`
    CREATE TABLE IF NOT EXISTS document_chunks (
      id          BIGSERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      document_id BIGINT  NOT NULL,
      chunk_index INTEGER NOT NULL,
      text        TEXT    NOT NULL,
      embedding   JSONB,
      created_at  BIGINT  NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_doc
      ON document_chunks(user_id, document_id, chunk_index);
    CREATE INDEX IF NOT EXISTS idx_chunks_user ON document_chunks(user_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_chunks_fts
      ON document_chunks USING GIN (to_tsvector('simple', text));
  `);
}

/**
 * Splits text on paragraph/sentence boundaries, never mid-word, with a
 * small overlap so a fact spanning a boundary is still retrievable.
 */
function chunkText(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  if (clean.length <= MAX_CHUNK_CHARS) return [clean];

  const chunks = [];
  let start = 0;
  while (start < clean.length && chunks.length < MAX_CHUNKS_PER_DOC) {
    let end = Math.min(start + MAX_CHUNK_CHARS, clean.length);
    if (end < clean.length) {
      // Prefer a sentence break, then any space, so words stay intact.
      const window = clean.slice(start, end);
      const sentence = Math.max(
        window.lastIndexOf(". "),
        window.lastIndexOf("। "),
        window.lastIndexOf("? "),
        window.lastIndexOf("! ")
      );
      const space = window.lastIndexOf(" ");
      const cut = sentence > MAX_CHUNK_CHARS * 0.5 ? sentence + 1
        : space > MAX_CHUNK_CHARS * 0.5 ? space
        : -1;
      if (cut > 0) end = start + cut;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks;
}

/**
 * Chunks + embeds a document's extracted text. Idempotent: re-indexing
 * replaces the previous chunks rather than duplicating them.
 */
async function indexDocument(userId, documentId, fullText) {
  const uid = mem.assertUser(userId);
  const chunks = chunkText(fullText);
  await run(`DELETE FROM document_chunks WHERE user_id=$1 AND document_id=$2`, [
    uid, documentId,
  ]);
  if (!chunks.length) return { chunks: 0, embedded: false };

  // One batch call for the whole document; null when unconfigured.
  const vecs = await embeddings.embed(chunks);
  const t = Date.now();
  for (let i = 0; i < chunks.length; i++) {
    await run(
      `INSERT INTO document_chunks (user_id,document_id,chunk_index,text,embedding,created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [uid, documentId, i, chunks[i], vecs?.[i] ? JSON.stringify(vecs[i]) : null, t]
    );
  }
  return { chunks: chunks.length, embedded: Boolean(vecs) };
}

/**
 * ENTITY-SCOPED document search (§18).
 *
 * @param {string} q       what the user is looking for ("court notice")
 * @param {string} person  optional person name to scope to
 * @returns candidates ranked semantically WITHIN the entity scope
 */
async function findDocuments(userId, q, { person = null, limit = 5 } = {}) {
  const uid = mem.assertUser(userId);
  const text = String(q || "").trim();

  // 1. STRUCTURED SCOPE FIRST — who/what is this about?
  let scoped = null;
  let scopeLabel = "";
  if (person) {
    const p = await mem.findPerson(uid, person);
    if (!p) return { scope: `person:${person}`, found: false, documents: [] };
    const profile = await mem.recallAbout(uid, p.name);
    scoped = profile.documents.map((d) => d.id);
    scopeLabel = `${p.name}${profile.cases.length ? ` (+${profile.cases.length} case)` : ""}`;
    // Named an entity with nothing attached: say so rather than silently
    // widening to every document the user owns.
    if (!scoped.length) {
      return { scope: scopeLabel, found: false, documents: [] };
    }
  }

  // 2. Candidate documents: the entity's set, or the whole library.
  const docs = scoped
    ? await query(
        `SELECT * FROM documents WHERE user_id=$1 AND id = ANY($2::bigint[])`,
        [uid, scoped]
      )
    : await query(
        `SELECT * FROM documents WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200`,
        [uid]
      );
  if (!docs.length) return { scope: scopeLabel, found: false, documents: [] };

  // 3. Rank: semantic over chunks when embeddings exist, lexical otherwise.
  const qvec = await embeddings.embedOne(text);
  const ids = docs.map((d) => d.id);
  const chunks = await query(
    `SELECT document_id, text, embedding FROM document_chunks
      WHERE user_id=$1 AND document_id = ANY($2::bigint[])`,
    [uid, ids]
  );

  const words = text.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const best = new Map(); // documentId -> {score, snippet}
  for (const c of chunks) {
    let score = 0;
    if (qvec && c.embedding) {
      const v = typeof c.embedding === "string" ? JSON.parse(c.embedding) : c.embedding;
      score = mem.cosine(qvec, v);
    } else {
      const low = c.text.toLowerCase();
      score = words.length
        ? words.filter((w) => low.includes(w)).length / words.length
        : 0;
    }
    const cur = best.get(String(c.document_id));
    if (!cur || score > cur.score) {
      best.set(String(c.document_id), { score, snippet: snippetAround(c.text, words) });
    }
  }

  const ranked = docs
    .map((d) => {
      const hit = best.get(String(d.id)) || { score: 0, snippet: "" };
      // Title/category matches count too — a scanned notice may have poor
      // OCR text but a good title.
      const meta = `${d.title} ${d.category} ${d.summary} ${d.filename}`.toLowerCase();
      const metaScore = words.length
        ? words.filter((w) => meta.includes(w)).length / words.length
        : 0;
      return {
        id: d.id,
        title: d.title || d.filename,
        category: d.category,
        date: d.doc_date,
        snippet: hit.snippet,
        score: Math.max(hit.score, metaScore * 0.9),
      };
    })
    // A match is required even inside an entity scope: asked for "Ravi's
    // passport" when only a court notice exists, the honest answer is "no
    // passport", not the nearest unrelated file. Listing everything a
    // person has is list_person_documents' job, not find_document's.
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return { scope: scopeLabel, found: ranked.length > 0, documents: ranked };
}

/**
 * A snippet centred on the matching passage. Returning the first 240
 * characters of the chunk showed the top of the page instead of the part
 * that actually matched, which is useless when the answer is on line 40.
 */
function snippetAround(text, words, width = 240) {
  if (!words.length) return text.slice(0, width);
  const low = text.toLowerCase();
  let at = -1;
  for (const w of words) {
    const i = low.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return text.slice(0, width);
  const start = Math.max(0, at - Math.floor(width / 3));
  const out = text.slice(start, start + width).trim();
  return (start > 0 ? "…" : "") + out + (start + width < text.length ? "…" : "");
}

/** Associates a document with a person and/or case, creating them if needed. */
async function associate(userId, documentId, { person = null, caseTitle = null }) {
  const uid = mem.assertUser(userId);
  const out = {};
  if (person) {
    const p = await mem.upsertPerson(uid, { name: person });
    await mem.linkDocument(uid, documentId, "person", p.id);
    out.person = p.name;
    if (caseTitle) {
      const c = await mem.upsertCase(uid, { title: caseTitle, personId: p.id });
      await mem.linkDocument(uid, documentId, "case", c.id);
      out.case = c.title;
    }
  } else if (caseTitle) {
    const c = await mem.upsertCase(uid, { title: caseTitle });
    await mem.linkDocument(uid, documentId, "case", c.id);
    out.case = c.title;
  }
  return out;
}

module.exports = {
  migrate,
  chunkText,
  indexDocument,
  findDocuments,
  associate,
  MAX_CHUNK_CHARS,
};
