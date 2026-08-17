/**
 * REMINDER ROUTES (behind appAuth)
 * GET    /reminders                    → { reminders }
 * POST   /reminders  { text, dueAt? }  → { reminder }
 * PATCH  /reminders/:id { done?, text?, dueAt? }
 * DELETE /reminders/:id
 */
const router = require("express").Router();
const store = require("./store");
const audit = require("../audit/log");

function uid(req, res) {
  let sub = req.user?.sub;
  if (sub === "anonymous-dev") sub = 0;
  const id = Number(sub);
  if (!Number.isInteger(id) || id < 0) {
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

router.get("/", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  res.json({ reminders: (await store.list(id)).map(shape) });
});

router.post("/", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const { text, dueAt } = req.body || {};
  const r = await store.create(id, text, Number.isFinite(dueAt) ? dueAt : null);
  if (!r) return res.status(400).json({ error: "text required" });
  audit.record(id, "reminder.created", r.text);
  res.json({ reminder: shape(r) });
});

router.patch("/:id", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const rid = Number(req.params.id);
  const { done, text, dueAt } = req.body || {};
  if (done !== undefined) await store.setDone(id, rid, !!done);
  let r = null;
  if (text !== undefined || dueAt !== undefined) {
    r = await store.update(id, rid, text, dueAt === undefined ? undefined : dueAt);
  }
  r = r || (await store.list(id)).find((x) => x.id === rid);
  if (!r) return res.status(404).json({ error: "not found" });
  res.json({ reminder: shape(r) });
});

router.delete("/:id", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const ok = await store.remove(id, Number(req.params.id));
  if (ok) audit.record(id, "reminder.deleted", `reminder #${req.params.id}`);
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "not found" });
});

module.exports = router;
