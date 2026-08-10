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
 * happened even before any document search runs.
 */
const router = require("express").Router();
const multer = require("multer");
const fs = require("fs");
const docs = require("../docs/store");
const { analyzeDocument } = require("../docs/analyze");
const audit = require("../audit/log");

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

/** Analyze + attach metadata — shared by fresh
 *  uploads and the lazy healing pass below. Never throws. */
async function analyzeInBackground(userId, row, buffer, mime) {
  try {
    const meta = await analyzeDocument(buffer, mime);
    if (!meta) return;
    const updated = (await docs.setMetadata(userId, row.id, meta)) || row;
    // A one-line durable fact ("context") so plain chat — with no document
    // search at all — still knows about the visit/purchase. Title + date
    // ONLY: the note/summary live on the document row and are injected by
    // doc search when relevant — duplicating them here made the AI read
    // the same content twice in recall answers.
    const when = meta.docDate || new Date().toISOString().slice(0, 10);
    await memory.remember(userId, {
      key: `doc_${updated.id}`,
      value: `Saved a ${updated.category || "document"}: "${updated.title}" dated ${when}`,
      category: "context",
      source: "ai",
    });
  } catch (e) {
    console.error("docs background analyze:", e.message);
  }
}

// One attempt per document per server boot — a doc that failed analysis
// (key missing at the time, quota, junk output) is retried when it's next
// listed, but a persistently broken setup can't hammer Gemini in a loop.
const healAttempted = new Set();

router.post(
  "/",
  upload.single("file"),
  async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const f = req.file;
  if (!f || !f.buffer?.length) return res.status(400).json({ error: "file required" });
  if (!OK_MIME.has(f.mimetype)) return res.status(415).json({ error: `unsupported type ${f.mimetype}` });

  const row = await docs.createDocument(id, {
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
  audit.record(id, "document.saved", f.originalname || `document #${row.id}`);

  healAttempted.add(row.id);
  await analyzeInBackground(id, row, f.buffer, f.mimetype);
});

router.get("/", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const rows = await docs.listDocuments(id);
  res.json({ documents: rows.map(docs.toClient) });

  // SELF-HEAL: docs whose analysis never landed (saved while the Gemini
  // key was missing or broken) OR that were analyzed before full-text
  // extraction existed get another background attempt now.
  if (!process.env.GEMINI_API_KEY) return;
  for (const row of rows) {
    if ((row.title && row.full_text) || healAttempted.has(row.id)) continue;
    healAttempted.add(row.id);
    fs.promises
      .readFile(row.path)
      .then((buf) => analyzeInBackground(id, row, buf, row.mime))
      .catch((e) => console.error("docs heal read:", e.message));
  }
});

router.get("/:id/file", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const row = await docs.getDocument(id, Number(req.params.id));
  if (!row || !fs.existsSync(row.path)) return res.status(404).json({ error: "not found" });
  res.setHeader("Content-Type", row.mime);
  res.setHeader("Cache-Control", "private, max-age=86400"); // immutable per id
  fs.createReadStream(row.path).pipe(res);
});

router.patch("/:id", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const ok = await docs.setNote(id, Number(req.params.id), req.body?.note);
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "not found" });
});

router.delete("/:id", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const docId = Number(req.params.id);
  const ok = await docs.deleteDocument(id, docId);
  if (ok) {
    await memory.deleteByKey?.(id, `doc_${docId}`);
    audit.record(id, "document.deleted", `document #${docId} and its memory fact`);
  }
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "not found" });
});

module.exports = router;
