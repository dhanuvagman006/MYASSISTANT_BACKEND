/**
 * WEB SEARCH — provider adapter.
 *
 * §28: no fake implementations. If no provider is configured this returns
 * an honest failure the agent reports as "I can't search the web yet",
 * rather than inventing results. Adding a key switches it on with no other
 * code change.
 *
 * Supported (first configured wins):
 *   BRAVE_SEARCH_API_KEY      https://api.search.brave.com
 *   TAVILY_API_KEY            https://tavily.com
 *   GOOGLE_CSE_KEY + GOOGLE_CSE_CX   Google Programmable Search
 */
const TIMEOUT_MS = 8000;

function provider() {
  if (process.env.BRAVE_SEARCH_API_KEY) return "brave";
  if (process.env.TAVILY_API_KEY) return "tavily";
  if (process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_CX) return "google";
  return null;
}

async function run(query) {
  const p = provider();
  if (!p) {
    return {
      ok: false,
      error:
        "web search is not configured on this server (set BRAVE_SEARCH_API_KEY, " +
        "TAVILY_API_KEY, or GOOGLE_CSE_KEY + GOOGLE_CSE_CX)",
    };
  }
  const q = String(query || "").trim().slice(0, 300);
  if (!q) return { ok: false, error: "empty query" };

  try {
    const results = await BACKENDS[p](q);
    if (!results.length) return { ok: false, error: "no results" };
    return {
      ok: true,
      data: results,
      // Compact digest for the model to summarise from.
      speak: results
        .slice(0, 5)
        .map((r, i) => `${i + 1}. ${r.title} — ${r.snippet}`)
        .join("\n"),
    };
  } catch (e) {
    return { ok: false, error: `search failed: ${String(e.message).slice(0, 160)}` };
  }
}

const BACKENDS = {
  async brave(q) {
    const r = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=6`,
      {
        headers: {
          accept: "application/json",
          "x-subscription-token": process.env.BRAVE_SEARCH_API_KEY,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }
    );
    if (!r.ok) throw new Error(`brave ${r.status}`);
    const j = await r.json();
    return (j.web?.results || []).map((x) => ({
      title: x.title,
      snippet: x.description,
      url: x.url,
    }));
  },

  async tavily(q) {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query: q,
        max_results: 6,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`tavily ${r.status}`);
    const j = await r.json();
    return (j.results || []).map((x) => ({
      title: x.title,
      snippet: x.content,
      url: x.url,
    }));
  },

  async google(q) {
    const u =
      `https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_CSE_KEY}` +
      `&cx=${process.env.GOOGLE_CSE_CX}&num=6&q=${encodeURIComponent(q)}`;
    const r = await fetch(u, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) throw new Error(`google cse ${r.status}`);
    const j = await r.json();
    return (j.items || []).map((x) => ({
      title: x.title,
      snippet: x.snippet,
      url: x.link,
    }));
  },
};

module.exports = { run, provider };
