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
const places = require("./tools/places");
const currency = require("./tools/currency");
const news = require("./tools/news");
const reminders = require("../reminders/store");
const memory = require("../memory/store");
const docsStore = require("../docs/store");
const gtokens = require("../google/tokens");
const gapi = require("../google/api");
const swiggyTokens = require("../swiggy/tokens");
const food = require("../swiggy/order");

const RE = {
  remindSet: /\b(remind me|set (a |an )?(reminder|alarm)|reminder (to|for)|don'?t let me forget)\b/i,
  remindList: /\b((what|list|show|any).{0,20}reminders?|my reminders)\b/i,
  weather: /\b(weather|temperature|forecast|rain(ing)?|hot|cold) (today|now|outside|tomorrow|in\b)|\bweather\b|\bforecast\b|\bumbrella\b/i,
  news: /\b(news|headlines?|what('| i)?s happening)\b/i,
  email: /\b(email|emails|mail|inbox|gmail)\b/i,
  calendar: /\b(calendar|meeting|meetings|appointments?|schedule|events?|agenda)\b/i,
  inCity: /\b(?:in|at|for) ([A-Za-z][A-Za-z .'-]{2,40})\s*\??$/i,
  briefing:
    /\b(morning|daily) briefing\b|\bbrief(ing)? (me|my day|about my day)\b|\bstart my day\b|\bhow('| i)?s my day look/i,
  nearby:
    /\b(near ?(me|by|est)|nearby|closest|around here|walking distance)\b|\bnear my (place|home|location)\b/i,
  docRecall:
    /\b(reports?|documents?|prescriptions?|receipts?|recipes?|records?|scan|photocopy|test results?|x-?rays?|lab (results?|reports?)|medical (file|history)|bill|invoice)\b|\b(doctor|hospital|clinic)\b.{0,40}\b(said|told|suggested|suggestions?|advice|advised|gave|prescribed|recommend\w*)\b|\b(said|told|suggested|suggestions?|advice|advised|gave|prescribed|recommend\w*)\b.{0,40}\b(doctor|hospital|clinic)\b/i,
  foodOrder:
    /\b(order|get|bring|deliver|book)\b.{0,40}\b(food|pizza|biryani|burger|dosa|idli|noodles|momos|thali|shawarma|rolls?|sandwich|cake|ice ?cream|meals?|dinner|lunch|breakfast|snacks?)\b|\bswiggy\b.{0,30}\border\b|\border\b.{0,30}\bswiggy\b|\bi('| a)?m (really |so |very )?hungry\b/i,
  yes: /^\s*(yes|yeah|yep|ya|sure|ok(ay)?|confirm|place (it|the order)|go ahead|do it|haan|ho|houdu|sari|ஆமாம்|హా|हाँ|ಹೌದು)[.! ]*$/i,
  no: /^\s*(no|nope|nah|cancel|don'?t|stop|leave it|beda|nako|nahi|नहीं|ಬೇಡ|வேண்டாம்|వద్దు)[.! ]*$/i,
};

/** "order a large veg pizza from swiggy please" → "large veg pizza" */
function extractCraving(msg) {
  let s = norm(msg)
    .replace(/\b(hey|hi|ok(ay)?|please|pls|can you|could you|will you|for me|right now|now|today|tonight|on|from|via|using|swiggy)\b/g, " ")
    .replace(/\b(order|get|bring|deliver|book|buy|want|need|i|am|is|a|an|some|the|my|me)\b/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!s || /^hungry$/.test(s)) s = "food";
  return s.slice(0, 60);
}
const norm = (s) => String(s || "").toLowerCase();

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
  /** Sources shown in the app under the reply (A5). Filled by whichever
   *  live tools actually ran — no extra network calls are ever made. */
  const sources = [];
  /** Saved documents matched by this turn — the app pops them up on screen
   *  while the reply is spoken (voice-to-voice recall). */
  const documents = [];

  if (msg) {
    try {
      // ---- FOOD ORDER (Swiggy MCP) — checked FIRST because a bare
      // "yes"/"no" is meaningless to every other intent. Real money:
      // the flow is deterministic and two-turn; the AI only phrases it. ----
      if (userId && food.hasPending(userId) && (RE.yes.test(msg) || RE.no.test(msg))) {
        const r = RE.yes.test(msg)
          ? await food.confirmPending(userId)
          : await food.cancelPending(userId);
        blocks.push("TOOL RESULT — SWIGGY: " + r.say);
        sources.push({ name: "Swiggy", url: "https://www.swiggy.com" });
        return { block: "\n\n" + blocks.join("\n\n"), sources, documents };
      }
      if (userId && RE.foodOrder.test(msg)) {
        if (!swiggyTokens.isLinked(userId)) {
          blocks.push(
            "TOOL RESULT — SWIGGY: the user asked to order food but has NOT " +
              "linked their Swiggy account. Tell them to open the You tab and " +
              "tap Connect Swiggy, then ask again. Do not pretend to order."
          );
        } else {
          try {
            const r = await food.prepareOrder(userId, extractCraving(msg));
            blocks.push("TOOL RESULT — SWIGGY: " + r.say);
            sources.push({ name: "Swiggy", url: "https://www.swiggy.com" });
          } catch (e) {
            console.error("swiggy prepare failed:", e.message);
            blocks.push(
              "TOOL RESULT — SWIGGY: ordering failed (" +
                (e.code === "NOT_LINKED" ? "account link expired — ask them to reconnect Swiggy in the You tab" : "service unavailable") +
                "). NO order was placed and NO cart exists. Apologize briefly; never claim an order happened."
            );
          }
        }
        return { block: "\n\n" + blocks.join("\n\n"), sources, documents };
      }

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
          sources.push({ name: "Open-Meteo" + (w?.label ? ` · ${w.label}` : ""), url: "https://open-meteo.com" });
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

      // ---- SAVED DOCUMENTS RECALL ("show me the report from my last
      // hospital visit") — pure FTS lookup, zero extra AI/network calls. ----
      if (userId && RE.docRecall.test(msg)) {
        const { hits, exact } = docsStore.searchDocuments(userId, msg, 3);
        if (hits.length) {
          for (const d of hits) documents.push(docsStore.toClient(d));
          const lines = hits.map((d, i) =>
            `${i + 1}. "${d.title || docsStore.fallbackTitle(d)}"` +
            (d.doc_date ? ` dated ${d.doc_date}` : "") +
            (d.summary ? ` — ${d.summary}` : "") +
            (d.note ? `\n   USER'S OWN NOTE (their words at save time): ${d.note}` : "")
          );
          blocks.push(
            (exact
              ? "TOOL RESULT — MATCHING SAVED DOCUMENTS (they are being SHOWN on the user's screen right now):\n"
              : "TOOL RESULT — no exact keyword match, so these are the user's MOST RECENT saved documents (SHOWN on their screen now). Be honest: say you're showing their recent saves and ask if one of these is it — do NOT claim a confirmed match:\n") +
              lines.join("\n") +
              "\nBriefly confirm it's on their screen, then answer their question FROM this data — " +
              "ONCE, in 1-3 sentences. NEVER repeat the same information twice in your reply. " +
              "NEVER say a file name aloud (no .jpg/.pdf names) — refer to it by its title or just 'this receipt/report'. " +
              "Include the USER'S OWN NOTE only when they asked what was said/suggested/advised, " +
              "or when it directly answers the question — otherwise skip it. " +
              "Never invent details that are not above."
          );
          sources.push({ name: "Your saved documents", url: "" });
        } else {
          blocks.push(
            "TOOL RESULT — DOCUMENT SEARCH: the user seems to be asking about a saved document, but nothing matching " +
              "was found in their saved documents. Say so briefly and remind them they can save reports and receipts " +
              "from the Documents screen so you can recall them later."
          );
        }
      }

      // ---- NEARBY PLACES (C3) ----
      if (RE.nearby.test(msg)) {
        try {
          const list = await places.searchPlaces({ q: msg.slice(0, 120), lat, lng });
          const d = places.describePlaces(list);
          blocks.push(
            "TOOL RESULT — LIVE nearby places (sorted by distance):\n" +
              (d || "(nothing found nearby)") +
              "\nRecommend the best 2-3 conversationally for speech. Mention the Today tab's Nearby section for call and directions buttons."
          );
          if (d) sources.push({ name: "Nearby search", url: "" });
        } catch (_) {}
      }

      // ---- CURRENCY (C4) ----
      {
        const ask = currency.parseCurrencyAsk(msg);
        if (ask) {
          try {
            const rate = await currency.getRate(ask.from, ask.to);
            const converted = Math.round(ask.amount * rate * 100) / 100;
            blocks.push(
              `TOOL RESULT — LIVE exchange rate: 1 ${ask.from} = ${rate} ${ask.to}. ` +
                `So ${ask.amount} ${ask.from} = ${converted} ${ask.to}. ` +
                "Answer from this real rate only."
            );
            sources.push({ name: "Frankfurter (ECB rates)", url: "https://www.frankfurter.app" });
          } catch (_) {}
        }
      }

      // ---- MORNING BRIEFING (C2): weather + reminders + calendar + news in ONE reply ----
      if (RE.briefing.test(msg)) {
        const parts = [];
        try {
          const w = await weather.getWeather({ lat, lng });
          const d = weather.describe(w);
          if (d) {
            parts.push("WEATHER: " + d);
            sources.push({ name: "Open-Meteo", url: "https://open-meteo.com" });
          }
        } catch (_) {}
        if (userId) {
          const listing = reminders.upcomingText(userId);
          parts.push("PENDING REMINDERS: " + (listing || "(none)"));
          if (gtokens.isConnected(userId)) {
            try {
              const ev = await gapi.upcomingEvents(userId, { days: 1 });
              const d = gapi.describeEvents(ev, tzOffsetMin);
              if (d) parts.push("TODAY'S CALENDAR: " + d);
            } catch (_) {}
          }
        }
        try {
          const items = await news.getHeadlines();
          if (items?.length) {
            parts.push(
              "HEADLINES: " + items.slice(0, 4).map((h) => h.title).join(" | ")
            );
            const seen = new Set();
            for (const h of items.slice(0, 4)) {
              if (h.source && !seen.has(h.source)) {
                seen.add(h.source);
                sources.push({ name: h.source, url: h.link || "" });
              }
            }
          }
        } catch (_) {}
        blocks.push(
          "TOOL RESULT — LIVE data for the user's DAILY BRIEFING:\n" +
            parts.join("\n") +
            "\nCompose a warm spoken briefing in the user's language: a short greeting, the weather in one line, today's calendar and pending reminders (skip gracefully if empty), then 2-3 headlines. Keep it under 30 seconds of speech; do not read URLs."
        );
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
          const seen = new Set();
          for (const h of items) {
            if (!h.source || seen.has(h.source)) continue;
            seen.add(h.source);
            sources.push({ name: h.source, url: h.link || "" });
            if (sources.length >= 5) break;
          }
        }
      }
    } catch (e) {
      // A tool failing must never break the chat — the AI just answers
      // without live data (and will naturally say it can't check).
      console.warn("intent tool skipped:", e.message);
    }
  }

  return { block: "\n\n" + blocks.join("\n\n"), sources, documents };
}

module.exports = { buildToolContext, parseReminder };
