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
const intelligence = require("../docs/intelligence");
const audit = require("../audit/log");
// BUGFIX (Aug 2026): `memory` was used below but never required — every
// DELETE /docs/:id threw ReferenceError, and the post-analysis memory
// fact silently never landed.
const memory = require("../agents/memory");
const clients = require("../clients/store");

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

    // CHUNK + EMBED the extracted text so "find Ravi's court notice" can
    // search inside the document, not just its title. Failure here must not
    // lose the document itself, so it is caught separately.
    try {
      const text = updated.full_text || meta.fullText || "";
      if (text) {
        // QUEUED, not inline: chunking + embedding a long PDF must never
        // sit in front of the user's next voice turn (§25).
        await require("../infra/jobs").enqueue(
          "document.index",
          { userId, documentId: row.id, text },
          { userId }
        );
      }
    } catch (e) {
      console.error("docs indexing enqueue failed (document kept):", e.message);
    }
    // A one-line durable fact ("context") so plain chat — with no document
    // search at all — still knows about the visit/purchase. Title + date
    // ONLY: the note/summary live on the document row and are injected by
    // doc search when relevant — duplicating them here made the AI read
    // the same content twice in recall answers.
    const when = meta.docDate || new Date().toISOString().slice(0, 10);
    await memory.saveMemory(
      userId,
      `Saved a ${updated.category || "document"}: "${updated.title}" dated ${when}`,
      1 // minor context fact — first to be evicted when memory is full
    );
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

  // PROFESSIONAL MODE: file the document under a client/patient.
  //  • explicit — the app sent clientId (upload from a case-file screen);
  //  • spoken   — the save-note names a known client ("this is patient
  //    Ramesh's blood report") → auto-link to the confident match only.
  let linkedClient = null;
  try {
    const explicit = Number(req.body.clientId);
    if (Number.isInteger(explicit) && explicit > 0) {
      if (await clients.linkDocument(id, row.id, explicit)) {
        linkedClient = await clients.getClient(id, explicit);
      }
    } else if (req.body.note) {
      const matches = await clients.findByName(id, req.body.note, 2);
      // Auto-link ONLY on an unambiguous, high-confidence hit — a wrong
      // guess in a patient file is worse than no guess.
      if (matches.length && matches[0].score >= 80 &&
          (matches.length === 1 || matches[1].score < matches[0].score)) {
        await clients.linkDocument(id, row.id, matches[0].client.id);
        linkedClient = matches[0].client;
      }
    }
  } catch (e) {
    console.warn("docs client-link skipped:", e.message);
  }

  // Respond the moment the file is safely on disk — a voice "save this
  // receipt" must not hold the conversation hostage to a slow AI call.
  // Analysis (title/summary/tags + the memory fact) completes in the
  // background and shows up on the next GET /docs.
  res.json({
    ok: true,
    document: docs.toClient(row),
    analyzed: false,
    // Filing confirmation for the app ("Saved to Ramesh's file").
    client: linkedClient ? { id: linkedClient.id, name: linkedClient.name } : null,
  });
  audit.record(
    id,
    "document.saved",
    (f.originalname || `document #${row.id}`) +
      (linkedClient ? ` → filed under "${linkedClient.name}"` : "")
  );

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
  // Read the row BEFORE deletion — the title identifies the context fact.
  const row = await docs.getDocument(id, docId);
  const ok = await docs.deleteDocument(id, docId);
  if (ok) {
    if (row?.title) {
      await memory.deleteFactsContaining(id, `"${row.title}"`).catch(() => {});
    }
    audit.record(id, "document.deleted", `document #${docId} and its memory fact`);
  }
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "not found" });
});

module.exports = router;
