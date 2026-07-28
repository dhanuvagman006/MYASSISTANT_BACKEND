/**
 * DOCUMENT ROUTES (all behind appAuth) — "save it so Hari remembers".
 *
 *   POST   /docs            multipart {file, note?} → analyzed + stored
 *   GET    /docs            → { documents: [...] }
 *   GET    /docs/:id/file   → the original bytes (image/PDF), auth required
 *   PATCH  /docs/:id        { note } → update the user's spoken note
 *   DELETE /docs/:id        → { ok }
 *
 * Upload flow: file is written to disk FIRST (the save can never be lost
 * to an AI hiccup), then one Gemini call fills title/summary/date/tags.
 * A short memory fact is also written so future chats know the visit
 * happened even before any document search runs.
 */
const router = require("express").Router();
const multer = require("multer");
const fs = require("fs");
const docs = require("../docs/store");
const { analyzeDocument } = require("../docs/analyze");
const memory = require("../memory/store");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 18 * 1024 * 1024 },
});
const OK_MIME = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

function uid(req, res) {
  const id = Number(req.user?.sub);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "documents require a signed-in account" });
    return null;
  }
  return id;
}

router.post("/", upload.single("file"), async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const f = req.file;
  if (!f || !f.buffer?.length) return res.status(400).json({ error: "file required" });
  if (!OK_MIME.has(f.mimetype)) return res.status(415).json({ error: `unsupported type ${f.mimetype}` });

  let row = docs.createDocument(id, {
    buffer: f.buffer,
    filename: f.originalname,
    mime: f.mimetype,
    note: req.body.note,
  });

  // Respond the moment the file is safely on disk — a voice "save this
  // receipt" must not hold the conversation hostage to a slow AI call.
  // Analysis (title/summary/tags + the memory fact) completes in the
  // background and shows up on the next GET /docs.
  res.json({ ok: true, document: docs.toClient(row), analyzed: false });

  try {
    const meta = await analyzeDocument(f.buffer, f.mimetype);
    if (!meta) return;
    row = docs.setMetadata(id, row.id, meta) || row;
    // A one-line durable fact ("context") so plain chat — with no document
    // search at all — still knows about the visit/purchase.
    const when = meta.docDate || new Date().toISOString().slice(0, 10);
    memory.remember(id, {
      key: `doc_${row.id}`,
      // Title + date ONLY. The note/summary live on the document row and
      // are injected by doc search when relevant — duplicating them here
      // made the AI read the same content twice in recall answers.
      value: `Saved a ${row.category || "document"}: "${row.title}" dated ${when}`,
      category: "context",
      source: "ai",
    });
  } catch (e) {
    console.error("docs background analyze:", e.message);
  }
});

router.get("/", (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  res.json({ documents: docs.listDocuments(id).map(docs.toClient) });
});

router.get("/:id/file", (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const row = docs.getDocument(id, Number(req.params.id));
  if (!row || !fs.existsSync(row.path)) return res.status(404).json({ error: "not found" });
  res.setHeader("Content-Type", row.mime);
  res.setHeader("Cache-Control", "private, max-age=86400"); // immutable per id
  fs.createReadStream(row.path).pipe(res);
});

router.patch("/:id", (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const ok = docs.setNote(id, Number(req.params.id), req.body?.note);
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "not found" });
});

router.delete("/:id", (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const docId = Number(req.params.id);
  const ok = docs.deleteDocument(id, docId);
  if (ok) memory.deleteByKey?.(id, `doc_${docId}`);
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "not found" });
});

module.exports = router;
