/**
 * CLIENT / PATIENT STORE (professional mode) — "the agent knows my people".
 * -------------------------------------------------------------------------
 * A doctor, lawyer, CA, tutor… works with many people. Each gets ONE case
 * file here: profile row (clients), dated notes (client_notes) and linked
 * documents (documents.client_id). Voice recall — "give me the details
 * about patient Ramesh" — resolves the spoken name to a client and reads
 * the whole file back.
 *
 * Everything is user-visible and user-deletable, same contract as
 * documents and memories: no hidden state. Schemas live in src/db.js.
 */
const { query, one, run } = require("../db");

const MAX_PER_USER = 500; // generous; a busy practice, not a CRM
const KINDS = new Set(["patient", "client", "student", "customer", "other"]);

const clean = (s, n) => String(s ?? "").trim().slice(0, n);

function cleanKind(k) {
  const v = String(k || "").trim().toLowerCase();
  return KINDS.has(v) ? v : "client";
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                */
/* ------------------------------------------------------------------ */

async function countClients(userId) {
  return (await one("SELECT COUNT(*)::int AS n FROM clients WHERE user_id = $1", [userId])).n;
}

async function createClient(userId, { name, kind, phone, email, summary, tags }) {
  const nm = clean(name, 120);
  if (!nm) throw new Error("client name required");
  if ((await countClients(userId)) >= MAX_PER_USER) {
    throw new Error(`client limit reached (${MAX_PER_USER})`);
  }
  const now = Date.now();
  return one(
    `INSERT INTO clients (user_id, name, kind, phone, email, summary, tags, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
    [userId, nm, cleanKind(kind), clean(phone, 40), clean(email, 160),
     clean(summary, 600), clean(tags, 300).toLowerCase(), now]
  );
}

async function getClient(userId, id) {
  return one("SELECT * FROM clients WHERE id = $1 AND user_id = $2", [Number(id), userId]);
}

async function listClients(userId, limit = 200) {
  return query(
    "SELECT * FROM clients WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2",
    [userId, Math.min(Number(limit) || 200, MAX_PER_USER)]
  );
}

/** Patch only the fields the caller sent; bumps updated_at. */
async function updateClient(userId, id, patch = {}) {
  const row = await getClient(userId, id);
  if (!row) return null;
  const next = {
    name: patch.name !== undefined ? clean(patch.name, 120) || row.name : row.name,
    kind: patch.kind !== undefined ? cleanKind(patch.kind) : row.kind,
    phone: patch.phone !== undefined ? clean(patch.phone, 40) : row.phone,
    email: patch.email !== undefined ? clean(patch.email, 160) : row.email,
    summary: patch.summary !== undefined ? clean(patch.summary, 600) : row.summary,
    tags: patch.tags !== undefined ? clean(patch.tags, 300).toLowerCase() : row.tags,
  };
  await run(
    `UPDATE clients SET name=$1, kind=$2, phone=$3, email=$4, summary=$5, tags=$6, updated_at=$7
     WHERE id=$8 AND user_id=$9`,
    [next.name, next.kind, next.phone, next.email, next.summary, next.tags,
     Date.now(), Number(id), userId]
  );
  return getClient(userId, id);
}

/** Deletes the client + notes; linked documents are KEPT but unlinked —
 *  deleting a person's card must never silently destroy saved files. */
async function deleteClient(userId, id) {
  const row = await getClient(userId, id);
  if (!row) return false;
  await run("DELETE FROM client_notes WHERE client_id = $1 AND user_id = $2", [Number(id), userId]);
  await run("UPDATE documents SET client_id = NULL WHERE client_id = $1 AND user_id = $2", [Number(id), userId]);
  await run("DELETE FROM clients WHERE id = $1 AND user_id = $2", [Number(id), userId]);
  return true;
}

async function touch(userId, id) {
  await run("UPDATE clients SET updated_at = $1 WHERE id = $2 AND user_id = $3",
    [Date.now(), Number(id), userId]);
}

/* ------------------------------------------------------------------ */
/* Notes                                                               */
/* ------------------------------------------------------------------ */

async function addNote(userId, clientId, text) {
  const t = clean(text, 2000);
  if (!t) return null;
  const row = await one(
    `INSERT INTO client_notes (user_id, client_id, text, created_at)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [userId, Number(clientId), t, Date.now()]
  );
  await touch(userId, clientId); // recently-discussed clients float up
  return row;
}

async function listNotes(userId, clientId, limit = 100) {
  return query(
    `SELECT * FROM client_notes WHERE user_id = $1 AND client_id = $2
     ORDER BY id DESC LIMIT $3`,
    [userId, Number(clientId), Math.min(Number(limit) || 100, 300)]
  );
}

async function deleteNote(userId, clientId, noteId) {
  return (await run(
    "DELETE FROM client_notes WHERE id = $1 AND client_id = $2 AND user_id = $3",
    [Number(noteId), Number(clientId), userId]
  )) > 0;
}

/* ------------------------------------------------------------------ */
/* Document linking                                                    */
/* ------------------------------------------------------------------ */

/** Attach/detach an existing saved document. clientId null = unlink. */
async function linkDocument(userId, docId, clientId) {
  if (clientId !== null && !(await getClient(userId, clientId))) return false;
  const ok = (await run(
    "UPDATE documents SET client_id = $1 WHERE id = $2 AND user_id = $3",
    [clientId === null ? null : Number(clientId), Number(docId), userId]
  )) > 0;
  if (ok && clientId !== null) await touch(userId, clientId);
  return ok;
}

async function listClientDocuments(userId, clientId, limit = 50) {
  return query(
    `SELECT * FROM documents WHERE user_id = $1 AND client_id = $2
     ORDER BY COALESCE(NULLIF(doc_date,''), '0') DESC, created_at DESC LIMIT $3`,
    [userId, Number(clientId), Math.min(Number(limit) || 50, 100)]
  );
}

/* ------------------------------------------------------------------ */
/* Voice name resolution                                               */
/* ------------------------------------------------------------------ */

/**
 * Spoken text → best-matching clients, most confident first.
 * STT never gives us a clean name ("pull up patient Ramesh Gowda's
 * file please"), so every stored client is scored against the words of
 * the message in Node — a practice has hundreds of rows, not millions,
 * and this beats SQL LIKE for partial/reordered names.
 *
 * Score: full-name substring 100 · every name word present 80 ·
 * some words 40/word · first-word prefix 25. Ties → recently updated.
 */
async function findByName(userId, spoken, limit = 3) {
  const msg = " " + String(spoken || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ") + " ";
  const msgWords = new Set(msg.trim().split(/\s+/).filter(Boolean));
  if (!msgWords.size) return [];

  const rows = await listClients(userId, MAX_PER_USER);
  const scored = [];
  for (const c of rows) {
    const name = String(c.name || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (!name) continue;
    const words = name.split(/\s+/);
    let score = 0;
    if (msg.includes(" " + name + " ")) score = 100;
    else {
      const hits = words.filter((w) => msgWords.has(w)).length;
      if (hits === words.length) score = 80;
      else if (hits > 0) score = 40 * hits;
      else {
        // prefix match helps STT clippings ("Ramesh" heard as "Rames")
        for (const mw of msgWords) {
          if (mw.length >= 4 && words[0].startsWith(mw)) { score = 25; break; }
        }
      }
    }
    if (score > 0) scored.push({ client: c, score });
  }
  scored.sort((a, b) => b.score - a.score || b.client.updated_at - a.client.updated_at);
  return scored.slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* Full profile (the "case file")                                      */
/* ------------------------------------------------------------------ */

/** Everything about one client in a single read: row + notes + docs. */
async function getProfile(userId, clientId) {
  const client = await getClient(userId, clientId);
  if (!client) return null;
  const [notes, documents] = await Promise.all([
    listNotes(userId, clientId),
    listClientDocuments(userId, clientId),
  ]);
  return { client, notes, documents };
}

/* ------------------------------------------------------------------ */
/* Public shapes                                                       */
/* ------------------------------------------------------------------ */

function toClient(c) {
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    phone: c.phone,
    email: c.email,
    summary: c.summary,
    tags: c.tags,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

function noteToClient(n) {
  return { id: n.id, clientId: n.client_id, text: n.text, createdAt: n.created_at };
}

module.exports = {
  MAX_PER_USER,
  countClients, createClient, getClient, listClients, updateClient, deleteClient,
  addNote, listNotes, deleteNote,
  linkDocument, listClientDocuments,
  findByName, getProfile,
  toClient, noteToClient,
};
