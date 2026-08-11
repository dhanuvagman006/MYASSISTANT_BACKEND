/**
 * SEARCH AGENT — real-time information, grounded in live data.
 *
 * Handles "what's happening with…", "news about…", "find restaurants
 * near me", "search for…". It FETCHES first (Google News RSS, Places,
 * weather — all existing tools), then has Gemini answer FROM that data,
 * so replies cite today's world instead of training-data guesses.
 *
 * Returns { text, used: [{tool,label}] } — the orchestrator turns `used`
 * into tool_started/tool_completed events so the app can show
 * "Search agent · checking the news…" cards live.
 */
const { generateReply } = require("../services/ai/router");
const news = require("../services/tools/news");
const places = require("../services/tools/places");
const weather = require("../services/tools/weather");

const NEWS_RX =
  /\b(news|headlines?|latest|happening|update on|what'?s going on)\b/i;
const PLACES_RX =
  /\b(near me|nearby|restaurants?|cafes?|hotels?|hospitals?|pharmac|petrol|atm|shops?|stores?|salon|gym|temple|around here)\b/i;
const WEATHER_RX = /\b(weather|rain|temperature|hot|cold|forecast|umbrella)\b/i;

// Current-affairs / factual questions that must be answered from LIVE
// sources, never from the model's stale training data: "who is the
// prime minister of X", "current president", "capital of", scores…
const FACTUAL_RX =
  /\b(who is|who'?s)\s+(the\s+)?(current\s+)?(prime minister|pm|president|ceo|chief minister|cm|governor|captain|coach|owner|founder|king|queen)\b|\b(capital|population|currency) of\b|\bhow (old|tall|rich) is\b|\bwhen (is|was|did)\b.*\b(match|election|festival|launch)\b/i;

/** Does this turn belong to the search agent at all? */
function matches(text) {
  return (
    NEWS_RX.test(text) ||
    PLACES_RX.test(text) ||
    WEATHER_RX.test(text) ||
    FACTUAL_RX.test(text) ||
    /\b(search|look up|find out|google)\b/i.test(text)
  );
}

/* ---------------- free live knowledge (no API keys) ---------------- */

const KNOW_TIMEOUT = 6000;

/** DuckDuckGo Instant Answers — free, keyless. */
async function duckduckgo(q) {
  const url =
    "https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=" +
    encodeURIComponent(q);
  const r = await fetch(url, { signal: AbortSignal.timeout(KNOW_TIMEOUT) });
  if (!r.ok) return null;
  const j = await r.json();
  const answer = j.Answer || j.AbstractText || j.Definition;
  if (answer) return String(answer).slice(0, 600);
  const rel = j.RelatedTopics?.find((t) => t.Text);
  return rel ? String(rel.Text).slice(0, 400) : null;
}

/** Wikipedia REST summary — free, keyless; good for people/places. */
async function wikipedia(q) {
  const s = await fetch(
    "https://en.wikipedia.org/w/rest.php/v1/search/title?limit=1&q=" +
      encodeURIComponent(q),
    { signal: AbortSignal.timeout(KNOW_TIMEOUT) }
  );
  if (!s.ok) return null;
  const sj = await s.json();
  const key = sj.pages?.[0]?.key;
  if (!key) return null;
  const r = await fetch(
    "https://en.wikipedia.org/api/rest_v1/page/summary/" +
      encodeURIComponent(key),
    { signal: AbortSignal.timeout(KNOW_TIMEOUT) }
  );
  if (!r.ok) return null;
  const j = await r.json();
  return j.extract ? String(j.extract).slice(0, 700) : null;
}

/** Strip question words down to a lookup subject. */
function subjectOf(text) {
  return text
    .replace(/\b(who is|who'?s|what is|what'?s|tell me about|search|look up|find out|about|the|current|please)\b/gi, " ")
    .replace(/[?.!]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 80);
}

/** Pull a topic out of "news about X" / "search for X" phrasing. */
function topicOf(text) {
  const m =
    /(?:news|headlines?|update|search|look up|find out)\s+(?:about|on|for)?\s*(.{2,60})$/i.exec(
      text.trim()
    );
  return m ? m[1].replace(/[?.!]+$/, "").trim() : null;
}

/**
 * @param {{text:string, lat?:number, lng?:number, history:Array}} turn
 * @returns {Promise<{text:string, used:Array<{tool:string,label:string}>}>}
 */
async function handle(turn) {
  const { text, lat, lng, history } = turn;
  const used = [];
  const grounding = [];

  if (WEATHER_RX.test(text) && Number.isFinite(lat) && Number.isFinite(lng)) {
    try {
      const w = await weather.getWeather({ lat, lng });
      if (w) {
        used.push({ tool: "weather", label: "Checking the weather…" });
        grounding.push("LIVE WEATHER: " + JSON.stringify(w));
      }
    } catch (_) {}
  }

  if (NEWS_RX.test(text) || /\b(search|look up|find out)\b/i.test(text)) {
    try {
      const topic = topicOf(text);
      const heads = await news.getHeadlines({ topic: topic || undefined });
      if (heads?.length) {
        used.push({ tool: "news", label: topic ? `Searching news for “${topic}”…` : "Reading today's headlines…" });
        grounding.push(
          "LIVE HEADLINES (today):\n" +
            heads.map((h) => `- ${h.title} (${h.source})`).join("\n")
        );
      }
    } catch (_) {}
  }

  if (PLACES_RX.test(text) && Number.isFinite(lat) && Number.isFinite(lng)) {
    try {
      const found = await places.searchPlaces({ q: text, lat, lng });
      if (found?.length) {
        used.push({ tool: "places", label: "Finding places nearby…" });
        grounding.push(
          "NEARBY PLACES:\n" +
            found
              .slice(0, 5)
              .map(
                (p) =>
                  `- ${p.name}${p.rating ? ` (${p.rating}★)` : ""}${p.distanceKm != null ? `, ${p.distanceKm} km` : ""}`
              )
              .join("\n")
        );
      }
    } catch (_) {}
  }

  // Factual "who/what is…" → free live knowledge, tried in order.
  if (FACTUAL_RX.test(text) || (grounding.length === 0 && /\b(search|look up|find out)\b/i.test(text))) {
    const subject = subjectOf(text);
    if (subject) {
      let fact = null;
      try {
        fact = await duckduckgo(text);
      } catch (_) {}
      if (!fact) {
        try {
          fact = await wikipedia(subject);
        } catch (_) {}
      }
      if (fact) {
        used.push({ tool: "knowledge", label: `Looking up ${subject}…` });
        grounding.push("LIVE KNOWLEDGE LOOKUP:\n" + fact);
      }
    }
  }

  const extraSystem =
    "\n\nROLE: SEARCH AGENT. Answer strictly FROM the live data below when it " +
    "covers the question; be concrete (names, numbers). If the data doesn't " +
    "cover it, say what you do know briefly and honestly.\n" +
    (grounding.length ? grounding.join("\n\n") : "(no live data matched)");

  const { reply } = await generateReply(history, { extraSystem });
  return { text: reply || "I couldn't find that just now.", used };
}

module.exports = { matches, handle };
