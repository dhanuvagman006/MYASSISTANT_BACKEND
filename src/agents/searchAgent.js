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

/** Does this turn belong to the search agent at all? */
function matches(text) {
  return (
    NEWS_RX.test(text) ||
    PLACES_RX.test(text) ||
    WEATHER_RX.test(text) ||
    /\b(search|look up|find out|google)\b/i.test(text)
  );
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

  const extraSystem =
    "\n\nROLE: SEARCH AGENT. Answer strictly FROM the live data below when it " +
    "covers the question; be concrete (names, numbers). If the data doesn't " +
    "cover it, say what you do know briefly and honestly.\n" +
    (grounding.length ? grounding.join("\n\n") : "(no live data matched)");

  const { reply } = await generateReply(history, { extraSystem });
  return { text: reply || "I couldn't find that just now.", used };
}

module.exports = { matches, handle };
