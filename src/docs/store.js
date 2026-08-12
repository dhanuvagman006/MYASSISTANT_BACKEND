/**
 * PER-USER DOCUMENT STORE (Postgres) — "the agent remembers".
 * -----------------------------------------------------------
 * Hospital reports, prescriptions, receipts, results… the user saves a
 * photo/PDF once, Hari keeps it forever and can PULL IT BACK UP from a
 * voice request ("show me the report from my last hospital visit").
 *
 * Layout:
 *   • metadata + AI summary → documents table (schema in src/db.js)
 *   • full-text search      → tsvector generated column + GIN index
 *     (was SQLite FTS5; matching happens in the index, never by scan)
 *   • file bytes            → DATA_DIR/files/<userId>/<docId>.<ext>
 *     (never in the DB — keeps it small and backups cheap)
 *
 * Everything is user-visible and user-deletable, same contract as the
 * facts memory: no hidden state.
 */
const fs = require("fs");
const path = require("path");
const { query, one, run } = require("../db");

const MAX_PER_USER = 100; // oldest doc evicted when full

const filesRoot = path.join(
  process.env.DATA_DIR || path.join(__dirname, "..", "..", "data"),
  "files"
);
fs.mkdirSync(filesRoot, { recursive: true });



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
  // Government / photo ID — the words people actually say when saving one.
  // Handles common STT mishearings of "aadhaar" (adhar/aadhar/aadar…).
  if (/\ba+dh?a+r\b|aadhaar|pan\s*card|\bpan\b|passport|licen[cs]e|driving|voter|ration\s*card|\bid\s*(card|proof)\b|identity|ಆಧಾರ್|आधार|ஆதார்|ఆధార్|ആധാർ/.test(n))
    return "id";
  return "other";
}

/** Save the file bytes + a metadata row. Returns the new row. */
async function createDocument(userId, { buffer, filename, mime, note = "" }) {
  // Cap: evict the oldest document (and its file) when the user is full.
  if ((await countDocuments(userId)) >= MAX_PER_USER) {
    const old = await one(
      "SELECT * FROM documents WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1",
      [userId]
    );
    if (old) await deleteDocument(userId, old.id);
  }
  const row = await one(
    `INSERT INTO documents (user_id, filename, mime, size, path, note, category, created_at)
     VALUES ($1, $2, $3, $4, '', $5, $6, $7) RETURNING id`,
    [userId, String(filename || "document").slice(0, 120), mime, buffer.length,
     String(note || "").trim().slice(0, 2000), guessCategory(note), Date.now()]
  );
  const id = row.id;
  const filePath = path.join(userDir(userId), id + extOf(mime, filename));
  fs.writeFileSync(filePath, buffer);
  await run("UPDATE documents SET path = $1 WHERE id = $2", [filePath, id]);
  return getDocument(userId, id);
}

/** Attach AI-extracted metadata (safe against junk model output). */
async function setMetadata(userId, id, { title, category, docDate, summary, tags, fullText }) {
  const CATS = new Set(["medical", "prescription", "receipt", "bill", "id", "ticket", "other"]);
  await run(
    `UPDATE documents SET title=$1, category=$2, doc_date=$3, summary=$4, tags=$5, full_text=$6
     WHERE id=$7 AND user_id=$8`,
    [
      String(title || "").trim().slice(0, 160),
      CATS.has(category) ? category : "other",
      /^\d{4}-\d{2}-\d{2}$/.test(String(docDate || "")) ? docDate : "",
      String(summary || "").trim().slice(0, 1200),
      (Array.isArray(tags) ? tags.join(", ") : String(tags || "")).toLowerCase().slice(0, 300),
      // Complete transcription — makes "read it to me / what's the total"
      // answerable from the REAL content. Capped; recall injects a slice.
      String(fullText || "").trim().slice(0, 12000),
      id, userId,
    ]
  );
  return getDocument(userId, id);
}

async function setNote(userId, id, note) {
  return (await run(
    "UPDATE documents SET note = $1 WHERE id = $2 AND user_id = $3",
    [String(note || "").trim().slice(0, 2000), id, userId]
  )) > 0;
}

async function getDocument(userId, id) {
  return one("SELECT * FROM documents WHERE id = $1 AND user_id = $2", [id, userId]);
}

async function listDocuments(userId, limit = 100) {
  return query(
    "SELECT * FROM documents WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
    [userId, Math.min(limit, 200)]
  );
}

async function deleteDocument(userId, id) {
  const row = await getDocument(userId, id);
  if (!row) return false;
  await run("DELETE FROM documents WHERE id = $1 AND user_id = $2", [id, userId]);
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
async function searchDocuments(userId, message, limit = 3) {
  const words = String(message || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
  const uniq = [...new Set(words)].slice(0, 8);

  const recentByCat = (a, b) =>
    query(
      `SELECT * FROM documents WHERE user_id = $1 AND category IN ($2, $3)
       ORDER BY COALESCE(NULLIF(doc_date,''), '0') DESC, created_at DESC LIMIT $4`,
      [userId, a, b, limit]
    );

  let rows = [];
  if (uniq.length) {
    // "blood | hospital | report" — OR-matched in the GIN index, ranked
    // by ts_rank (the Postgres analogue of FTS5's BM25 rank).
    const q = uniq.map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean).join(" | ");
    try {
      rows = await query(
        `SELECT *, ts_rank(fts, to_tsquery('simple', $1)) AS rank
         FROM documents WHERE fts @@ to_tsquery('simple', $1) AND user_id = $2
         ORDER BY rank DESC LIMIT $3`,
        [q, userId, limit]
      );
    } catch (_) {}
  }
  if (rows.length === 0 && /\b(hospital|doctor|clinic|medical|prescri|report|test|lab|health)\w*/i.test(message)) {
    rows = await recentByCat("medical", "prescription");
  }
  if (rows.length === 0 && /\b(receipt|bill|invoice|paid|payment)\w*/i.test(message)) {
    rows = await recentByCat("receipt", "bill");
  }
  if (rows.length === 0 &&
      /\ba+dh?a+r\b|aadhaar|\bpan\b|passport|licen[cs]e|driving|voter|ration|\bid\b|identity|ಆಧಾರ್|आधार|ஆதார்|ఆధార్|ആധാർ/i.test(message)) {
    // "show my Aadhaar / PAN / passport" — surface saved ID documents.
    rows = await recentByCat("id", "id");
  }
  if (rows.length) return { hits: rows, exact: true };

  // LAST RESORT: the user is clearly asking about a saved document —
  // showing their most recent saves beats a flat "nothing found".
  return { hits: (await listDocuments(userId)).slice(0, limit), exact: false };
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
    clientId: d.client_id || null, // professional mode: which case file it's in
    createdAt: d.created_at,
  };
}

/** How many documents a user has saved (plan-cap checks). */
async function countDocuments(userId) {
  return (await one("SELECT COUNT(*)::int AS n FROM documents WHERE user_id = $1", [userId])).n;
}

module.exports = {
  countDocuments,
  createDocument,
  guessCategory,
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
