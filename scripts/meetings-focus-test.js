/**
 * Unit tests: Focus Guard analyzer (google/focus.js) and Meeting Copilot
 * extraction (meetings/extract.js). Pure — no DB, no network, no AI keys.
 */
const assert = (cond, msg) => {
  if (!cond) {
    console.error("ASSERT FAILED:", msg);
    process.exit(1);
  }
  console.log("  ✓", msg);
};

const { analyzeLoad } = require("../src/google/focus");
const {
  parseExtraction,
  validateExtraction,
  processTranscript,
} = require("../src/meetings/extract");

console.log("meetings-focus-test");

// ---------- Focus Guard ----------

// helper: build an event on a fixed UTC day at hour:min for dur minutes
const DAY = "2026-08-10"; // Monday
const ev = (id, title, h, m, durMin) => {
  const start = new Date(`${DAY}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
  return {
    id,
    title,
    start: start.toISOString(),
    end: new Date(start.getTime() + durMin * 60_000).toISOString(),
    allDay: false,
  };
};

// 1) 10:00–14:00 back-to-back (4h) → one run, buffer at 14:00, candidate picked
{
  const events = [
    ev("a", "Design review", 10, 0, 60),
    ev("b", "Team standup", 11, 0, 30), // low-priority by title
    ev("c", "Client call", 11, 30, 90),
    ev("d", "Roadmap", 13, 0, 60),
    ev("e", "Dinner", 18, 30, 60), // separate, not part of the run
  ];
  const r = analyzeLoad(events);
  assert(r.runs.length === 1 && r.runs[0].totalMin === 240, "detects a single 4h back-to-back run");
  assert(r.buffers.length === 1 && new Date(r.buffers[0].startMs).toISOString().includes("14:00"), "proposes a buffer right after the stretch");
  assert(r.buffers[0].endMs - r.buffers[0].startMs === 30 * 60_000, "buffer is 30 minutes");
  assert(r.reschedule.length === 1 && r.reschedule[0].id === "b", "reschedule candidate is the low-priority standup");
}

// 2) gaps ≤ 15 min still count as back-to-back; > 15 min breaks the run
{
  const joined = analyzeLoad([ev("a", "A", 9, 0, 90), ev("b", "B", 10, 40, 120)]); // 10-min gap
  assert(joined.runs.length === 1, "10-min gap still counts as back-to-back");
  const split = analyzeLoad([ev("a", "A", 9, 0, 90), ev("b", "B", 11, 0, 120)]); // 30-min gap
  assert(split.runs.length === 0, "30-min gap breaks the run (neither piece exceeds 3h)");
}

// 3) light day → nothing flagged; all-day events ignored
{
  const r = analyzeLoad([
    { id: "x", title: "Holiday", start: DAY, end: DAY, allDay: true },
    ev("a", "One meeting", 10, 0, 60),
  ]);
  assert(r.runs.length === 0 && r.buffers.length === 0 && r.reschedule.length === 0, "light day produces an empty plan");
}

// 4) no buffer proposed when the slot after the run is occupied
{
  const r = analyzeLoad([
    ev("a", "A", 9, 0, 120),
    ev("b", "B", 11, 0, 120), // run ends 13:00
    ev("c", "Lunch", 13, 20, 60), // 20-min gap breaks the run but occupies 13:00–13:30 slot's tail
  ]);
  assert(r.runs.length === 1 && r.buffers.length === 0, "occupied slot after a run yields no buffer");
}

// 5) working-hours guard: run ending 20:30 local → no 20:30 buffer
{
  const r = analyzeLoad([ev("a", "Late A", 17, 30, 90), ev("b", "Late B", 19, 0, 90)]);
  assert(r.runs.length === 1 && r.buffers.length === 0, "no buffer proposed outside working hours");
}

// 6) tz shift: same late run is mid-afternoon at UTC+5:30 → buffer allowed
{
  const r = analyzeLoad(
    [ev("a", "A", 8, 0, 120), ev("b", "B", 10, 0, 120)], // ends 12:00 UTC = 17:30 IST
    { tzOffsetMin: 330 }
  );
  assert(r.buffers.length === 1 && new Date(r.buffers[0].startMs).toISOString().includes("12:00"), "tzOffsetMin judges working hours in user-local time, output stays UTC");
}

// ---------- Meeting Copilot: parse + validate ----------

// 7) plain JSON and fenced JSON both parse
{
  const obj = { decisions: ["Ship Friday"], actions: [], followUpDraft: null };
  assert(parseExtraction(JSON.stringify(obj)).decisions[0] === "Ship Friday", "parses a plain JSON reply");
  const fenced = "Here you go:\n```json\n" + JSON.stringify(obj) + "\n```";
  assert(parseExtraction(fenced).decisions[0] === "Ship Friday", "parses a fenced/prefixed reply");
}

// 8) garbage throws
{
  let threw = false;
  try {
    parseExtraction("I could not find anything useful.");
  } catch (_) {
    threw = true;
  }
  assert(threw, "non-JSON model output throws instead of passing through");
}

// 9) validation coerces schema: bad due dates → null, missing owner → unassigned, junk rows dropped
{
  const v = validateExtraction({
    decisions: ["Move launch to Sept", 42, ""],
    actions: [
      { owner: "Priya", task: "Update deck", due: "2026-08-14" },
      { task: "Ping vendor", due: "next Tuesday" }, // bad date, no owner
      { owner: "X" }, // no task → dropped
    ],
    followUpDraft: { subject: "Recap", body: "Thanks all — notes attached." },
  });
  assert(v.decisions.length === 1, "non-string / empty decisions dropped");
  assert(v.actions.length === 2 && v.actions[0].due === "2026-08-14", "valid ISO due date kept");
  assert(v.actions[1].owner === "unassigned" && v.actions[1].due === null, "missing owner → unassigned, non-ISO due → null");
  assert(v.followUpDraft.subject === "Recap", "draft kept when subject+body present");
}

// 10) fully empty extraction throws (better a 502 than an empty 200)
{
  let threw = false;
  try {
    validateExtraction({ decisions: [], actions: [], followUpDraft: null });
  } catch (_) {
    threw = true;
  }
  assert(threw, "empty extraction is rejected");
}

// ---------- Meeting Copilot: end-to-end with injected model ----------

(async () => {
  // 11) happy path with a fake provider
  const fakeGood = async () => ({
    reply:
      '{"decisions":["Adopt plan B"],"actions":[{"owner":"Ravi","task":"Draft SOW","due":"2026-08-20"}],' +
      '"followUpDraft":{"subject":"Plan B next steps","body":"Hi all, we agreed on plan B."}}',
  });
  const out = await processTranscript(
    "Ravi: I think plan B is safer. Meera: agreed, let's adopt plan B. Ravi will draft the SOW by the 20th.",
    { generate: fakeGood }
  );
  assert(out.decisions[0] === "Adopt plan B" && out.actions[0].owner === "Ravi", "processTranscript returns validated structure via injected model");

  // 12) provider failure propagates (route turns this into a 502)
  let threw = false;
  try {
    await processTranscript("A long enough transcript for the size gate to pass here.", {
      generate: async () => {
        throw new Error("All providers failed");
      },
    });
  } catch (_) {
    threw = true;
  }
  assert(threw, "provider failure propagates for the route's 502");

  // 13) tiny transcript rejected before any model call
  threw = false;
  try {
    await processTranscript("hi", { generate: fakeGood });
  } catch (_) {
    threw = true;
  }
  assert(threw, "too-short transcript rejected without calling the model");

  console.log("meetings-focus-test: all passed");
})();
