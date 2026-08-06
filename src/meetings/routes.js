/**
 * MEETING COPILOT ROUTES (behind appAuth)
 * POST /meetings/process-transcript
 *   body:  { transcript, stageReminders?: boolean }
 *   reply: { decisions, actions, followUpDraft, stagedReminders }
 *
 * followUpDraft is deliberately the same { subject, body } shape the app
 * already sends to POST /google/draft — the app shows the draft for the
 * user to review and THEY choose to save it; nothing is auto-sent
 * (same review-before-send rule as D2).
 *
 * stageReminders=true creates a reminder for each action item that has a
 * due date, so extracted tasks land in the user's existing C1 list and
 * fire real notifications. Explicit opt-in only.
 */
const router = require("express").Router();
const { processTranscript } = require("./extract");
const reminders = require("../reminders/store");

function uid(req, res) {
  const id = Number(req.user?.sub);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "requires a signed-in account" });
    return null;
  }
  return id;
}

router.post("/process-transcript", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const { transcript, stageReminders } = req.body || {};
  if (!transcript || String(transcript).trim().length < 40) {
    return res
      .status(400)
      .json({ error: "transcript required (at least a few sentences)" });
  }

  let out;
  try {
    out = await processTranscript(transcript);
  } catch (e) {
    // Model down, provider chain exhausted, or unusable output — degrade
    // honestly instead of returning a malformed 200.
    return res
      .status(502)
      .json({ error: "could not analyse the transcript right now" });
  }

  const stagedReminders = [];
  if (stageReminders === true) {
    for (const a of out.actions) {
      if (!a.due) continue; // no date → belongs in the summary, not a timer
      const dueAt = Date.parse(a.due + "T09:00:00Z"); // 9:00 UTC morning nudge
      if (!Number.isFinite(dueAt) || dueAt < Date.now()) continue;
      try {
        const r = await reminders.create(
          id,
          `${a.task}${a.owner !== "unassigned" ? ` (owner: ${a.owner})` : ""}`,
          dueAt
        );
        stagedReminders.push(r);
      } catch (_) {
        /* one bad row never fails the whole response */
      }
    }
  }

  res.json({ ...out, stagedReminders });
});

module.exports = router;
