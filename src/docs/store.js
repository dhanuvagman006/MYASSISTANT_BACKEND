/**
 * PER-USER DOCUMENT STORE — Group B upgrade: "the agent remembers".
 * -----------------------------------------------------------------
 * Hospital reports, prescriptions, receipts, results… the user saves a
 * photo/PDF once, Hari keeps it forever and can PULL IT BACK UP from a
 * voice request ("show me the report from my last hospital visit").
 *
 * Layout:
 *   • metadata + AI summary → SQLite row (documents table)
 *   • full-text search      → FTS5 index kept in sync by triggers
 *     (BM25-ranked, millisecond lookups even with millions of rows —
 *     matching is done in the index, never by scanning summaries)
 *   • file bytes            → DATA_DIR/files/<userId>/<docId>.<ext>
 *     (never in SQLite — keeps the DB small and backups cheap)
 *
 * Everything is user-visible and user-deletable, same contract as the
 * facts memory: no hidden state.
 */
const fs = require("fs");
const path = require("path");
const { db } = require("../db");

const MAX_PER_USER = 100; // oldest doc evicted when full

const filesRoot = path.join(
  process.env.DATA_DIR || path.join(__dirname, "..", "..", "data"),
  "files"
);
fs.mkdirSync(filesRoot, { recursive: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    filename   TEXT NOT NULL,
    mime       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    path       TEXT NOT NULL,               -- absolute path on disk
    title      TEXT NOT NULL DEFAULT '',    -- AI: "Blood test report — City Hospital"
    category   TEXT NOT NULL DEFAULT 'other', -- medical|prescription|receipt|bill|id|ticket|other
    doc_date   TEXT NOT NULL DEFAULT '',    -- ISO yyyy-mm-dd from the document itself
    summary    TEXT NOT NULL DEFAULT '',    -- AI plain-language summary (searchable)
    note       TEXT NOT NULL DEFAULT '',    -- user's own words, e.g. doctor's suggestions
    tags       TEXT NOT NULL DEFAULT '',    -- "hospital, diabetes, dr rao"
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_docs_user ON documents(user_id, created_at DESC);

  CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
    title, summary, note, tags, filename,
    content='documents', content_rowid='id', tokenize='unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON documents BEGIN
    INSERT INTO docs_fts(rowid, title, summary, note, tags, filename)
    VALUES (new.id, new.title, new.summary, new.note, new.tags, new.filename);
  END;
  CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON documents BEGIN
    INSERT INTO docs_fts(docs_fts, rowid, title, summary, note, tags, filename)
    VALUES ('delete', old.id, old.title, old.summary, old.note, old.tags, old.filename);
  END;
  CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON documents BEGIN
    INSERT INTO docs_fts(docs_fts, rowid, title, summary, note, tags, filename)
    VALUES ('delete', old.id, old.title, old.summary, old.note, old.tags, old.filename);
    INSERT INTO docs_fts(rowid, title, summary, note, tags, filename)
    VALUES (new.id, new.title, new.summary, new.note, new.tags, new.filename);
  END;
`);

const stmts = {
  insert: db.prepare(`
    INSERT INTO documents (user_id, filename, mime, size, path, note, category, created_at)
    VALUES (@user_id, @filename, @mime, @size, @path, @note, @category, @now)
  `),
  setMeta: db.prepare(`
    UPDATE documents SET title=@title, category=@category, doc_date=@doc_date,
      summary=@summary, tags=@tags WHERE id=@id AND user_id=@user_id
  `),
  setNote: db.prepare(
    "UPDATE documents SET note=? WHERE id=? AND user_id=?"
  ),
  byId: db.prepare("SELECT * FROM documents WHERE id=? AND user_id=?"),
  list: db.prepare(
    "SELECT * FROM documents WHERE user_id=? ORDER BY created_at DESC LIMIT ?"
  ),
  count: db.prepare("SELECT COUNT(*) AS n FROM documents WHERE user_id=?"),
  oldest: db.prepare(
    "SELECT * FROM documents WHERE user_id=? ORDER BY created_at ASC LIMIT 1"
  ),
  del: db.prepare("DELETE FROM documents WHERE id=? AND user_id=?"),
  recentByCat: db.prepare(`
    SELECT * FROM documents WHERE user_id=? AND category IN (?, ?)
    ORDER BY COALESCE(NULLIF(doc_date,''), '0') DESC, created_at DESC LIMIT ?
  `),
  search: db.prepare(`
    SELECT d.* FROM docs_fts f JOIN documents d ON d.id = f.rowid
    WHERE docs_fts MATCH ? AND d.user_id = ?
    ORDER BY rank LIMIT ?
  `),
};

function userDir(userId) {
  const dir = path.join(filesRoot, String(userId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function extOf(mime, filename) {
  if (mime === "application/pdf") return ".pdf";
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  const e = path.extname(filename || "");
  return /^\.[a-z0-9]{2,5}$/i.test(e) ? e.toLowerCase() : ".jpg";
}

/** Category guessed from the user's own words ("save this receipt…") so
 *  recall-by-category works IMMEDIATELY, before any AI analysis — and
 *  still works if analysis fails. AI refines it later via setMetadata. */
function guessCategory(note) {
  const n = String(note || "").toLowerCase();
  if (/receipt|reciept|recipe|ರಸೀದಿ|रसीद|രസീത|ரசீது|రసీదు/.test(n)) return "receipt";
  if (/\bbill\b|invoice|ಬಿಲ್|बिल|பில்|బిల/.test(n)) return "bill";
  if (/prescription|पर्च/.test(n)) return "prescription";
  if (/report|test|lab|scan|x-?ray|medical/.test(n)) return "medical";
  if (/ticket/.test(n)) return "ticket";
  return "other";
}

/** Save the file bytes + a metadata row. Returns the new row. */
function createDocument(userId, { buffer, filename, mime, note = "" }) {
  // Cap: evict the oldest document (and its file) when the user is full.
  if (stmts.count.get(userId).n >= MAX_PER_USER) {
    const old = stmts.oldest.get(userId);
    if (old) deleteDocument(userId, old.id);
  }
  const info = stmts.insert.run({
    user_id: userId,
    filename: String(filename || "document").slice(0, 120),
    mime,
    size: buffer.length,
    path: "", // set right after — we need the id for the filename
    note: String(note || "").trim().slice(0, 2000),
    category: guessCategory(note),
    now: Date.now(),
  });
  const id = info.lastInsertRowid;
  const filePath = path.join(userDir(userId), id + extOf(mime, filename));
  fs.writeFileSync(filePath, buffer);
  db.prepare("UPDATE documents SET path=? WHERE id=?").run(filePath, id);
  return stmts.byId.get(id, userId);
}

/** Attach AI-extracted metadata (safe against junk model output). */
function setMetadata(userId, id, { title, category, docDate, summary, tags }) {
  const CATS = new Set(["medical", "prescription", "receipt", "bill", "id", "ticket", "other"]);
  stmts.setMeta.run({
    id,
    user_id: userId,
    title: String(title || "").trim().slice(0, 160),
    category: CATS.has(category) ? category : "other",
    doc_date: /^\d{4}-\d{2}-\d{2}$/.test(String(docDate || "")) ? docDate : "",
    summary: String(summary || "").trim().slice(0, 1200),
    tags: (Array.isArray(tags) ? tags.join(", ") : String(tags || ""))
      .toLowerCase()
      .slice(0, 300),
  });
  return stmts.byId.get(id, userId);
}

function setNote(userId, id, note) {
  return (
    stmts.setNote.run(String(note || "").trim().slice(0, 2000), id, userId)
      .changes > 0
  );
}

function getDocument(userId, id) {
  return stmts.byId.get(id, userId);
}

function listDocuments(userId, limit = 100) {
  return stmts.list.all(userId, Math.min(limit, 200));
}

function deleteDocument(userId, id) {
  const row = stmts.byId.get(id, userId);
  if (!row) return false;
  stmts.del.run(id, userId);
  try { fs.unlinkSync(row.path); } catch (_) {}
  return true;
}

/**
 * Voice recall: free text → best-matching documents.
 * The message is reduced to content words, OR-ed into an FTS query
 * ("blood" OR "hospital" OR "report") and ranked by BM25. Falls back to
 * the most recent medical docs when the query is only "hospital/doctor"
 * talk with no other keywords, so "my last hospital visit" always works.
 */
const STOP = new Set(
  ("show me the of my last a an that this those what did say said tell told give open find pull up play from for and or in on at to i you was were is are it he she they doctor doctors please can could would will hari yesterday today recent latest visit visited went hospital clinic report reports document documents file files photo copy photocopy receipt result results record records suggested suggestion suggestions advice prescribed"
  ).split(" ")
);
/** @returns {{hits: object[], exact: boolean}} — `exact:false` means the
 *  last-resort path fired: nothing matched the words, so these are simply
 *  the user's most recent documents (the caller must present them
 *  honestly, not as confirmed matches). */
function searchDocuments(userId, message, limit = 3) {
  const words = String(message || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
  const uniq = [...new Set(words)].slice(0, 8);

  let rows = [];
  if (uniq.length) {
    const q = uniq.map((w) => `"${w}"`).join(" OR ");
    try { rows = stmts.search.all(q, userId, limit); } catch (_) {}
  }
  if (rows.length === 0 && /\b(hospital|doctor|clinic|medical|prescri|report|test|lab|health)\w*/i.test(message)) {
    rows = stmts.recentByCat.all(userId, "medical", "prescription", limit);
  }
  if (rows.length === 0 && /\b(receipt|bill|invoice|paid|payment)\w*/i.test(message)) {
    rows = stmts.recentByCat.all(userId, "receipt", "bill", limit);
  }
  if (rows.length) return { hits: rows, exact: true };

  // LAST RESORT: the user is clearly asking about a saved document (the
  // caller's intent regex already fired) — showing their most recent
  // saves beats a flat "nothing found" when keywords/categories miss
  // (e.g. analysis hasn't run yet, or they used different words).
  return { hits: listDocuments(userId).slice(0, limit), exact: false };
}

/** Human title when AI analysis hasn't landed (or failed): guess the kind
 *  from the user's own words + the save date — NEVER the raw filename
 *  ("voice_save_1785246909049.jpg" must not be shown or spoken). */
function fallbackTitle(d) {
  const m = /receipt|reciept|recipe|bill|invoice|prescription|report|warranty|ticket|statement/i
    .exec(d.note || "");
  const word = m ? m[0].toLowerCase() : "";
  const kind =
    word === "recipe" || word === "reciept"
      ? "Receipt" // STT mishearing — in a save-note it's virtually always a receipt
      : word
        ? word[0].toUpperCase() + word.slice(1)
        : d.mime === "application/pdf"
          ? "Document"
          : "Photo";
  const date = new Date(d.created_at).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${kind} · ${date}`;
}

/** Compact public shape sent to the app (never the disk path). */
function toClient(d) {
  return {
    id: d.id,
    filename: d.filename,
    mime: d.mime,
    size: d.size,
    title: d.title || fallbackTitle(d),
    category: d.category,
    docDate: d.doc_date,
    summary: d.summary,
    note: d.note,
    tags: d.tags,
    createdAt: d.created_at,
  };
}

module.exports = {
  createDocument,
  setMetadata,
  setNote,
  getDocument,
  listDocuments,
  deleteDocument,
  searchDocuments,
  toClient,
  fallbackTitle,
  MAX_PER_USER,
};
