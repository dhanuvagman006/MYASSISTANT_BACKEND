/**
 * MEMORY ROUTES (all behind appAuth)
 * GET    /memory        → { memories: [...] }         list everything Hari knows
 * POST   /memory        { key, value, category? }     user adds/edits a fact
 * DELETE /memory/:id    → { ok }                      forget one fact
 * DELETE /memory        → { ok, deleted }             forget everything
 *
 * Powers the app's "Privacy & memory → WHAT I REMEMBER" screen:
 * every fact visible, every fact deletable — no hidden state.
 */
const router = require("express").Router();
const store = require("../memory/store");
const { extractAndSave } = require("../memory/extractor");

/** Dev/X-App-Key sessions have non-numeric subs — no per-user memory there. */
function uid(req, res) {
  const id = Number(req.user?.sub);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "memory requires a signed-in account" });
    return null;
  }
  return id;
}

router.get("/", (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  res.json({
    memories: store.listMemories(id).map((m) => ({
      id: m.id,
      category: m.category,
      key: m.key,
      value: m.value,
      source: m.source,
      updatedAt: m.updated_at,
    })),
  });
});

router.post("/", (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const { key, value, category } = req.body || {};
  const saved = store.remember(id, { key, value, category, source: "user" });
  if (!saved) return res.status(400).json({ error: "key and value required" });
  res.json({ ok: true, memory: { id: saved.id, key: saved.key, value: saved.value } });
});

/**
 * POST /memory/interview { question, answer }
 * One answer from the sign-up interview. The extractor runs IMMEDIATELY
 * (force: no throttle — answers arrive seconds apart and all matter).
 * If the AI can't extract anything (or no provider is configured), the
 * raw answer is stored keyed by the question so nothing is ever lost.
 */
router.post("/interview", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const question = String(req.body?.question || "").slice(0, 300);
  const answer = String(req.body?.answer || "").trim().slice(0, 500);
  if (!answer) return res.status(400).json({ error: "answer required" });

  const saved = await extractAndSave(
    id,
    `(Sign-up interview) Hari asked: "${question}" — the user answered: "${answer}"`,
    "",
    { force: true }
  );
  if (saved.length === 0) {
    const fallback = store.remember(id, {
      key: `interview_${store.slugKey(question).slice(0, 40) || "answer"}`,
      value: answer,
      category: "fact",
      source: "user",
    });
    if (fallback) saved.push(fallback);
  }
  res.json({ ok: true, learned: saved.length });
});

router.delete("/:id", (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const ok = store.deleteMemory(id, Number(req.params.id));
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "not found" });
});

router.delete("/", (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  res.json({ ok: true, deleted: store.clearMemories(id) });
});

module.exports = router;
