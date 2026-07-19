/**
 * INTENT LAYER (assistant "tools")
 * --------------------------------
 * Runs BEFORE the AI on every /chat call. It detects actionable intents
 * in the user's last message, EXECUTES them (create a reminder, fetch
 * live weather/news), and returns a LIVE DATA block that is appended to
 * the system prompt — the AI then phrases the answer naturally IN THE
 * USER'S LANGUAGE, grounded in real data instead of hallucinating.
 *
 * Design choices:
 *  • Deterministic actions (reminder writes) happen here, not in the AI —
 *    the AI can't silently fail to create a reminder.
 *  • Date/time is ALWAYS injected (assistants must know "now"; the model
 *    alone does not).
 *  • Time parsing: chrono-node on the user's clock (X-TZ-Offset header,
 *    minutes east of UTC, i.e. IST = 330).
 */
const chrono = require("chrono-node");
const weather = require("./tools/weather");
const news = require("./tools/news");
const reminders = require("../reminders/store");
const memory = require("../memory/store");
const gtokens = require("../google/tokens");
const gapi = require("../google/api");

const RE = {
  remindSet: /\b(remind me|set (a |an )?(reminder|alarm)|reminder (to|for)|don'?t let me forget)\b/i,
  remindList: /\b((what|list|show|any).{0,20}reminders?|my reminders)\b/i,
  weather: /\b(weather|temperature|forecast|rain(ing)?|hot|cold) (today|now|outside|tomorrow|in\b)|\bweather\b|\bforecast\b|\bumbrella\b/i,
  news: /\b(news|headlines?|what('| i)?s happening)\b/i,
  email: /\b(email|emails|mail|inbox|gmail)\b/i,
  calendar: /\b(calendar|meeting|meetings|appointments?|schedule|events?|agenda)\b/i,
  inCity: /\b(?:in|at|for) ([A-Za-z][A-Za-z .'-]{2,40})\s*\??$/i,
};

/** "remind me to call amma tomorrow at 5" → { text, dueAt } */
function parseReminder(msg, now, tzOffsetMin) {
  // chrono works on the user's wall clock: shift the reference.
  const ref = { instant: now, timezone: tzOffsetMin };
  const results = chrono.parse(msg, ref, { forwardDate: true });
  let dueAt = null;
  let text = msg;
  if (results.length > 0) {
    const r = results[results.length - 1];
    dueAt = r.start.date().getTime();
    text = (msg.slice(0, r.index) + " " + msg.slice(r.index + r.text.length)).trim();
  }
  text = text
    .replace(RE.remindSet, "")
    .replace(/^\s*(to|that|about|me|please)\b/i, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^[,.:;-]+|[,.:;-]+$/g, "")
    .trim();
  if (!text) text = "Reminder";
  return { text, dueAt };
}

/**
 * @returns {Promise<string>} extra system-prompt block ("" when no intent)
 */
async function buildToolContext({ userId, messages, tzOffsetMin = 330, lat, lng }) {
  const lastUser = [...(messages || [])].reverse().find((m) => m.role === "user");
  const msg = lastUser ? String(lastUser.content || "") : "";
  const now = new Date();

  // Assistants must know the clock. Rendered in the user's timezone.
  const local = new Date(now.getTime() + tzOffsetMin * 60_000);
  const blocks = [
    `Current date and time for the user: ${local.toISOString().replace("T", " ").slice(0, 16)} ` +
      `(UTC${tzOffsetMin >= 0 ? "+" : ""}${(tzOffsetMin / 60).toFixed(1).replace(".0", "")}).`,
  ];

  if (msg) {
    try {
      // ---- REMINDER: CREATE (deterministic side effect) ----
      if (userId && RE.remindSet.test(msg)) {
        const { text, dueAt } = parseReminder(msg, now, tzOffsetMin);
        const r = reminders.create(userId, text, dueAt);
        if (r) {
          blocks.push(
            "TOOL RESULT — a reminder WAS JUST CREATED for the user: " +
              `"${r.text}"` +
              (r.due_at
                ? `, due ${new Date(r.due_at + tzOffsetMin * 60_000)
                    .toISOString().replace("T", " ").slice(0, 16)} (user's local time)`
                : ", with no set time") +
              ". Confirm it back to them naturally in one short sentence " +
              "(mention the day and time if set). Do not say you are unable to set reminders."
          );
        }
      }
      // ---- REMINDER: LIST ----
      else if (userId && RE.remindList.test(msg)) {
        const listing = reminders.upcomingText(userId);
        blocks.push(
          "TOOL RESULT — the user's current reminders:\n" +
            (listing || "(none)") +
            "\nRead them back conversationally with friendly times; if none, say so warmly."
        );
      }

      // ---- WEATHER ----
      if (RE.weather.test(msg)) {
        const cityAsk = msg.match(RE.inCity)?.[1]?.trim();
        const cityMem = userId
          ? memory.listMemories(userId).find((m) => m.key === "current_city")
              ?.value?.replace(/^is currently in\s*/i, "")
          : null;
        const w = await weather.getWeather({
          city: cityAsk || undefined,
          lat: cityAsk ? undefined : lat,
          lng: cityAsk ? undefined : lng,
          ...(!cityAsk && !Number.isFinite(lat) && cityMem ? { city: cityMem } : {}),
        });
        const d = weather.describe(w);
        if (d) {
          blocks.push(
            "TOOL RESULT — LIVE " + d +
              " Answer the user's weather question from this real data only."
          );
        }
      }

      // ---- GMAIL ----
      if (userId && RE.email.test(msg)) {
        if (!gtokens.isConnected(userId)) {
          blocks.push(
            "TOOL RESULT — the user asked about email but has NOT connected " +
              "their Gmail. Tell them to open the Today tab → Inbox and tap " +
              "Connect Gmail; do not invent email contents."
          );
        } else {
          const emails = await gapi.recentEmails(userId);
          const d = gapi.describeEmails(emails);
          blocks.push(
            "TOOL RESULT — LIVE " +
              (d || "Inbox: no recent primary emails.") +
              "\nAnswer from this real data only; summarize the important ones for speech, never invent."
          );
        }
      }

      // ---- CALENDAR ----
      if (userId && RE.calendar.test(msg) && !RE.remindSet.test(msg)) {
        if (!gtokens.isConnected(userId)) {
          blocks.push(
            "TOOL RESULT — the user asked about their calendar but has NOT " +
              "connected Google Calendar. Tell them to connect it from the " +
              "Today tab → Inbox → Connect; do not invent events."
          );
        } else {
          const events = await gapi.upcomingEvents(userId);
          const d = gapi.describeEvents(events, tzOffsetMin);
          blocks.push(
            "TOOL RESULT — LIVE " +
              (d || "Calendar: nothing scheduled in the next 7 days.") +
              "\nAnswer from this real data only."
          );
        }
      }

      // ---- NEWS ----
      if (RE.news.test(msg)) {
        const topicM = msg.match(/news (?:about|on|regarding) (.{2,60})/i);
        const items = await news.getHeadlines({ topic: topicM?.[1]?.trim() });
        const d = news.describe(items, topicM?.[1]?.trim());
        if (d) {
          blocks.push(
            "TOOL RESULT — LIVE " + d +
              "\nSummarize the 3–4 most important ones conversationally for speech; do not read URLs."
          );
        }
      }
    } catch (e) {
      // A tool failing must never break the chat — the AI just answers
      // without live data (and will naturally say it can't check).
      console.warn("intent tool skipped:", e.message);
    }
  }

  return "\n\n" + blocks.join("\n\n");
}

module.exports = { buildToolContext, parseReminder };
