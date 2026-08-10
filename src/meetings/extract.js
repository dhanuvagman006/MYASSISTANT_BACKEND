/**
 * MEETING COPILOT — transcript → structured decisions / action items /
 * follow-up email draft (Scope addendum, Aug 2026).
 *
 * Design:
 *  - The LLM call is INJECTABLE ({ generate }) so unit tests run with a
 *    fake and no API keys; production uses services/ai/router (Gemini
 *    fallback chain, so provider outages degrade gracefully for free).
 *  - The model's output is never trusted: parseExtraction() strips code
 *    fences, JSON-parses, then validateExtraction() coerces the result
 *    into the exact schema or throws. Bad model output = 502 to the app,
 *    never a malformed 200.
 *
 * Schema (the app and /google/draft both consume this shape):
 * {
 *   decisions:  [string],
 *   actions:    [{ owner: string, task: string, due: string|null }],  // due: ISO date or null
 *   followUpDraft: { subject: string, body: string } | null
 * }
 */

const MAX_TRANSCRIPT_CHARS = 60_000; // ~15k tokens; longer gets truncated head+tail
const MAX_ITEMS = 25;

const EXTRACTION_SYSTEM =
  "You extract structure from meeting transcripts. Respond with ONLY a JSON " +
  "object — no prose, no markdown fences — exactly this shape: " +
  '{"decisions":["…"],"actions":[{"owner":"…","task":"…","due":"YYYY-MM-DD or null"}],' +
  '"followUpDraft":{"subject":"…","body":"…"}}. ' +
  "decisions: firm choices the group settled on, one short sentence each. " +
  "actions: concrete tasks with the named owner ('unassigned' if none) and a " +
  "due date ONLY when the transcript states or clearly implies one, else null. " +
  "followUpDraft: a brief professional email summarising outcomes and next " +
  "steps, or null if the meeting had no outcomes worth mailing. " +
  "Never invent decisions, owners or dates that are not in the transcript.";

function clampTranscript(t) {
  if (t.length <= MAX_TRANSCRIPT_CHARS) return t;
  const half = MAX_TRANSCRIPT_CHARS / 2;
  return (
    t.slice(0, half) +
    "\n…[middle of transcript truncated]…\n" +
    t.slice(-half)
  );
}

/** Strip ``` fences and parse. Throws on non-JSON. */
function parseExtraction(text) {
  let s = String(text || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // tolerate a model that prefixes a sentence before the object
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last <= first) throw new Error("no JSON object in reply");
  return JSON.parse(s.slice(first, last + 1));
}

const str = (v, max = 400) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

/** Coerce into the exact schema; throws if fundamentally unusable. */
function validateExtraction(raw) {
  if (!raw || typeof raw !== "object") throw new Error("not an object");

  const decisions = (Array.isArray(raw.decisions) ? raw.decisions : [])
    .map((d) => str(d))
    .filter(Boolean)
    .slice(0, MAX_ITEMS);

  const actions = (Array.isArray(raw.actions) ? raw.actions : [])
    .map((a) => ({
      owner: str(a?.owner, 80) || "unassigned",
      task: str(a?.task),
      due: /^\d{4}-\d{2}-\d{2}$/.test(String(a?.due)) ? String(a.due) : null,
    }))
    .filter((a) => a.task)
    .slice(0, MAX_ITEMS);

  let followUpDraft = null;
  if (raw.followUpDraft && typeof raw.followUpDraft === "object") {
    const subject = str(raw.followUpDraft.subject, 150);
    const body = str(raw.followUpDraft.body, 4000);
    if (subject && body) followUpDraft = { subject, body };
  }

  if (decisions.length === 0 && actions.length === 0 && !followUpDraft) {
    throw new Error("extraction empty");
  }
  return { decisions, actions, followUpDraft };
}

/**
 * @param transcript raw text
 * @param deps       { generate } — async (messages, opts) => { reply }
 * @returns validated extraction object
 * @throws  Error("transcript required") | provider errors | schema errors
 */
async function processTranscript(transcript, deps = {}) {
  const t = String(transcript || "").trim();
  if (t.length < 40) throw new Error("transcript required");
  const generate =
    deps.generate || require("../services/ai/router").generateReply;

  const { reply } = await generate(
    [{ role: "user", content: "TRANSCRIPT:\n" + clampTranscript(t) }],
    { system: EXTRACTION_SYSTEM }
  );
  return validateExtraction(parseExtraction(reply));
}

module.exports = { processTranscript, parseExtraction, validateExtraction };
