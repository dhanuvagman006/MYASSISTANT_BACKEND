/**
 * CLIENT / PATIENT ROUTES (all behind appAuth) — professional mode.
 *
 *   GET    /clients                       → { clients }
 *   POST   /clients   {name, kind?, …}    → { client }
 *   GET    /clients/:id                   → { client, notes, documents }  (full case file)
 *   PATCH  /clients/:id  {any field}      → { client }
 *   DELETE /clients/:id                   → { ok }   (docs are UNLINKED, never deleted)
 *   POST   /clients/:id/notes   {text}    → { note }
 *   DELETE /clients/:id/notes/:noteId     → { ok }
 *   POST   /clients/:id/docs/:docId       → { ok }   link an existing saved document
 *   DELETE /clients/:id/docs/:docId       → { ok }   unlink (document itself survives)
 *
 * Sensitive by nature (patient files!), so every case-file read is
 * audit-logged — the professional can show WHO looked at WHAT and WHEN
 * from the privacy screen.
 */
const router = require("express").Router();
const store = require("../clients/store");
const docsStore = require("../docs/store");
const audit = require("../audit/log");

function uid(req, res) {
  let sub = req.user?.sub;
  if (sub === "anonymous-dev") sub = 0;
  const id = Number(sub);
  if (!Number.isInteger(id) || id < 0) {
    res.status(400).json({ error: "clients require a signed-in account" });
    return null;
  }
  return id;
}

router.get("/", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const rows = await store.listClients(id);
  res.json({ clients: rows.map(store.toClient) });
});

router.post("/", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    const row = await store.createClient(id, req.body || {});
    audit.record(id, "client.created", `${row.kind} "${row.name}"`);
    res.json({ client: store.toClient(row) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/:id", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const profile = await store.getProfile(id, Number(req.params.id));
  if (!profile) return res.status(404).json({ error: "not found" });
  audit.record(id, "client.viewed", `case file of "${profile.client.name}"`);
  res.json({
    client: store.toClient(profile.client),
    notes: profile.notes.map(store.noteToClient),
    documents: profile.documents.map(docsStore.toClient),
  });
});

router.patch("/:id", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const row = await store.updateClient(id, Number(req.params.id), req.body || {});
  if (!row) return res.status(404).json({ error: "not found" });
  res.json({ client: store.toClient(row) });
});

router.delete("/:id", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const row = await store.getClient(id, Number(req.params.id));
  const ok = await store.deleteClient(id, Number(req.params.id));
  if (ok) audit.record(id, "client.deleted", `"${row?.name}" (documents kept, unlinked)`);
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "not found" });
});

/* ---------------- notes ---------------- */

router.post("/:id/notes", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const client = await store.getClient(id, Number(req.params.id));
  if (!client) return res.status(404).json({ error: "client not found" });
  const note = await store.addNote(id, client.id, req.body?.text);
  if (!note) return res.status(400).json({ error: "text required" });
  audit.record(id, "client.note.added", `note on "${client.name}"`);
  res.json({ note: store.noteToClient(note) });
});

router.delete("/:id/notes/:noteId", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const ok = await store.deleteNote(id, Number(req.params.id), Number(req.params.noteId));
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "not found" });
});

/* ---------------- document links ---------------- */

router.post("/:id/docs/:docId", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const ok = await store.linkDocument(id, Number(req.params.docId), Number(req.params.id));
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "client or document not found" });
});

router.delete("/:id/docs/:docId", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  // Verify the doc currently belongs to THIS client before unlinking.
  const doc = await docsStore.getDocument(id, Number(req.params.docId));
  if (!doc || Number(doc.client_id) !== Number(req.params.id)) {
    return res.status(404).json({ error: "not found" });
  }
  const ok = await store.linkDocument(id, Number(req.params.docId), null);
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "not found" });
});

module.exports = router;
