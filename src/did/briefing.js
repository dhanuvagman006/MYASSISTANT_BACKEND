/**
 * DAILY VIDEO BRIEFING — Hari's face reads your morning summary.
 *
 * Pipeline (all server-side, one video per user per day, cached):
 *   1. Gather live facts: weather (last GPS fix or remembered city),
 *      today's reminders, top headlines.
 *   2. ONE AI call turns the facts into a warm 60–90 word spoken script
 *      in the user's language (name-personalized from memory).
 *   3. D-ID /talks renders the avatar video asynchronously (~15–45s).
 *   4. The app polls GET /did/briefing until status=done, then plays
 *      result_url. Tomorrow, a fresh one.
 */
const did = require("./client");
const store = require("./store");
const { generateReply } = require("../services/ai/router");
const { listMemories } = require("../memory/store");
const reminders = require("../reminders/store");
const weatherTool = require("../services/tools/weather");
const newsTool = require("../services/tools/news");

/** YYYY-MM-DD in the user's timezone (IST default). */
function dayKey(tzOffsetMin = 330) {
  const d = new Date(Date.now() + tzOffsetMin * 60_000);
  return d.toISOString().slice(0, 10);
}

async function buildScript(userId, { lat, lng } = {}) {
  const mems = userId ? await listMemories(userId).catch(() => []) : [];
  const get = (k) => mems.find((m) => (m.key || "").includes(k))?.value;
  const name = get("name") || get("call");
  const city = get("city");

  const [wx, rems, headlines] = await Promise.all([
    weatherTool
      .getWeather(lat && lng ? { lat, lng } : city ? { city } : { city: "Mysuru" })
      .catch(() => null),
    userId ? reminders.upcomingText(userId, { max: 4 }).catch(() => "") : "",
    newsTool.getHeadlines({ max: 3 }).catch(() => []),
  ]);

  const facts = [
    name ? `User's name: ${name}.` : "",
    wx ? `Weather: ${weatherTool.describe(wx)}` : "",
    rems ? `Today's reminders: ${rems}` : "No reminders today.",
    headlines.length
      ? `Headlines: ${headlines.map((h) => h.title || h).join(" | ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const { reply } = await generateReply(
    [{ role: "user", content: "(Generate my morning briefing video script.)" }],
    {
      extraSystem:
        "\n\nTASK: Write Hari's spoken MORNING VIDEO BRIEFING from these live facts:\n" +
        facts +
        "\nRules: 60-90 words total, warm and personal (greet by name if known), " +
        "flow naturally like a friendly news anchor, mention weather, then " +
        "reminders, then one or two headlines. Plain spoken prose only.",
    }
  );
  return (reply || "").trim();
}

/**
 * Return today's briefing row, creating it (script + D-ID talk) if
 * missing, and refreshing processing→done by polling D-ID once per call.
 */
async function todayBriefing(userId, { tzOffsetMin, lat, lng, generate } = {}) {
  const day = dayKey(tzOffsetMin);
  let row = await store.getBriefing(userId, day);

  if (!row && !generate) return null; // nothing yet; app shows a "Generate" button

  if (!row) {
    // Reserve the slot first so double-taps don't render two videos.
    row = await store.upsertBriefing(userId, day, { status: "creating" });
    try {
      const script = await buildScript(userId, { lat, lng });
      if (!script) throw new Error("empty script");
      const talk = await did.createTalk({ text: script });
      row = await store.upsertBriefing(userId, day, {
        talk_id: talk.id,
        status: "processing",
        script,
      });
    } catch (e) {
      console.error("briefing create failed:", e.message);
      row = await store.upsertBriefing(userId, day, { status: "error" });
    }
  }

  // Poll D-ID lazily — the app's own polling drives this forward.
  if (row.status === "processing" && row.talk_id) {
    try {
      const talk = await did.getTalk(row.talk_id);
      if (talk.status === "done" && talk.result_url) {
        row = await store.upsertBriefing(userId, day, {
          status: "done",
          result_url: talk.result_url,
        });
      } else if (talk.status === "error" || talk.status === "rejected") {
        row = await store.upsertBriefing(userId, day, { status: "error" });
      }
    } catch (_) {
      /* transient — next poll retries */
    }
  }
  return row;
}

module.exports = { todayBriefing, dayKey };
