/**
 * REMINDER ROUTES (behind appAuth)
 * GET    /reminders                    → { reminders }
 * POST   /reminders  { text, dueAt? }  → { reminder }
 * PATCH  /reminders/:id { done?, text?, dueAt? }
 * DELETE /reminders/:id
 */
const router = require("express").Router();
const store = require("./store");

function uid(req, res) {
  const id = Number(req.user?.sub);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "reminders require a signed-in account" });
    return null;
  }
  return id;
}

const shape = (r) => ({
  id: r.id,
  text: r.text,
  dueAt: r.due_at,
  done: !!r.done,
  createdAt: r.created_at,
});

router.get("/", (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  res.json({ reminders: store.list(id).map(shape) });
});

router.post("/", (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const { text, dueAt } = req.body || {};
  const r = store.create(id, text, Number.isFinite(dueAt) ? dueAt : null);
  if (!r) return res.status(400).json({ error: "text required" });
  res.json({ reminder: shape(r) });
});

router.patch("/:id", (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const rid = Number(req.params.id);
  const { done, text, dueAt } = req.body || {};
  if (done !== undefined) store.setDone(id, rid, !!done);
  let r = null;
  if (text !== undefined || dueAt !== undefined) {
    r = store.update(id, rid, text, dueAt === undefined ? undefined : dueAt);
  }
  r = r || store.list(id).find((x) => x.id === rid);
  if (!r) return res.status(404).json({ error: "not found" });
  res.json({ reminder: shape(r) });
});

router.delete("/:id", (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const ok = store.remove(id, Number(req.params.id));
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "not found" });
});

module.exports = router;
