/**
 * FOCUS GUARD — "Smart Calendar & Energy Defender" (Scope addendum, Aug 2026).
 *
 * Pure functions only: takes the event list that gapi.upcomingEvents()
 * already returns ({ id, title, start, end, allDay }) and computes
 *   - overload runs: back-to-back meeting stretches longer than a threshold
 *   - buffer proposals: 30-min focus/rest blocks in the free slots around them
 *   - reschedule candidates: the lowest-stakes meeting inside each run
 *
 * No I/O and no Date.now() dependence beyond the caller-supplied "from",
 * so the whole thing is unit-testable offline (scripts/meetings-focus-test.js).
 *
 * The route layer (google/routes.js) is the only place that talks to
 * Google; applying a buffer reuses the existing createEvent() write path
 * and the app's D3 preview-then-approve pattern — the server NEVER
 * inserts events on its own.
 */

const DEFAULTS = {
  runThresholdMin: 180, // "back-to-back > 3 consecutive hours"
  gapToleranceMin: 15,  // gaps shorter than this still count as back-to-back
  bufferMin: 30,        // proposed focus/rest block length
  dayStartHour: 8,      // never propose buffers outside working hours
  dayEndHour: 20,
};

// Meetings whose titles suggest they're easiest to move or skip.
const LOW_PRIORITY_RE =
  /\b(standup|stand-up|sync|check[- ]?in|optional|fyi|catch[- ]?up|1:1|one[- ]on[- ]one)\b/i;

function toMs(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Timed (non-all-day) events, normalised to ms and sorted by start. */
function timedEvents(events) {
  return (events || [])
    .filter((e) => e && !e.allDay && e.start && e.end)
    .map((e) => ({
      id: e.id,
      title: e.title || "(untitled)",
      startMs: toMs(e.start),
      endMs: toMs(e.end),
    }))
    .filter((e) => e.startMs !== null && e.endMs !== null && e.endMs > e.startMs)
    .sort((a, b) => a.startMs - b.startMs);
}

/**
 * Group events into "runs": consecutive meetings where each gap is
 * ≤ gapToleranceMin. Overlapping meetings belong to the same run.
 */
function findRuns(evts, gapToleranceMin) {
  const runs = [];
  let cur = null;
  for (const e of evts) {
    if (cur && e.startMs - cur.endMs <= gapToleranceMin * 60_000) {
      cur.events.push(e);
      cur.endMs = Math.max(cur.endMs, e.endMs);
    } else {
      cur = { startMs: e.startMs, endMs: e.endMs, events: [e] };
      runs.push(cur);
    }
  }
  return runs;
}

/** Pick the meeting in a run that's cheapest to move: low-priority title
 *  first, then simply the shortest. Never suggests a run's only meeting
 *  twice in the output — one candidate per run keeps it actionable. */
function rescheduleCandidate(run) {
  if (run.events.length < 2) return null; // moving the only meeting = pointless
  const scored = run.events
    .map((e) => ({
      ...e,
      lowPriority: LOW_PRIORITY_RE.test(e.title),
      durMin: Math.round((e.endMs - e.startMs) / 60_000),
    }))
    .sort(
      (a, b) =>
        Number(b.lowPriority) - Number(a.lowPriority) || a.durMin - b.durMin
    );
  const pick = scored[0];
  return {
    id: pick.id,
    title: pick.title,
    startMs: pick.startMs,
    durMin: pick.durMin,
    reason: pick.lowPriority
      ? "recurring/low-stakes by its title"
      : "shortest meeting in the stretch",
  };
}

/** True if [s,e) overlaps any event in the sorted list. */
function overlapsAny(evts, s, e) {
  return evts.some((ev) => ev.startMs < e && ev.endMs > s);
}

function withinWorkingHours(ms, durMin, opt) {
  const d = new Date(ms);
  const endD = new Date(ms + durMin * 60_000);
  return (
    d.getUTCHours() * 60 + d.getUTCMinutes() >= opt.dayStartHour * 60 &&
    endD.getUTCHours() * 60 + endD.getUTCMinutes() <= opt.dayEndHour * 60 &&
    d.getUTCDate() === endD.getUTCDate()
  );
}

/**
 * Main entry.
 * @param events  output of gapi.upcomingEvents()
 * @param opts    { tzOffsetMin } from the app (working hours are judged in
 *                the USER's local clock) + any DEFAULTS override.
 * @returns { runs, buffers, reschedule } — all times in epoch ms.
 */
function analyzeLoad(events, opts = {}) {
  const opt = { tzOffsetMin: 0, ...DEFAULTS, ...opts };
  // shift into user-local time for working-hour checks, then shift back
  const shift = opt.tzOffsetMin * 60_000;
  const evts = timedEvents(events).map((e) => ({
    ...e,
    startMs: e.startMs + shift,
    endMs: e.endMs + shift,
  }));

  const overloads = findRuns(evts, opt.gapToleranceMin).filter(
    (r) => r.endMs - r.startMs >= opt.runThresholdMin * 60_000
  );

  const buffers = [];
  const reschedule = [];
  for (const run of overloads) {
    // Propose a buffer right AFTER the stretch, in the first free slot.
    let s = run.endMs;
    const e = s + opt.bufferMin * 60_000;
    if (!overlapsAny(evts, s, e) && withinWorkingHours(s, opt.bufferMin, opt)) {
      buffers.push({
        startMs: s - shift,
        endMs: e - shift,
        afterRunOfMin: Math.round((run.endMs - run.startMs) / 60_000),
      });
    }
    const cand = rescheduleCandidate(run);
    if (cand) {
      reschedule.push({ ...cand, startMs: cand.startMs - shift });
    }
  }

  return {
    runs: overloads.map((r) => ({
      startMs: r.startMs - shift,
      endMs: r.endMs - shift,
      meetings: r.events.length,
      totalMin: Math.round((r.endMs - r.startMs) / 60_000),
    })),
    buffers,
    reschedule,
  };
}

module.exports = { analyzeLoad, DEFAULTS };
