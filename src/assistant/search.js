/**
 * WEB SEARCH — provider adapter chain, first configured provider wins:
 *
 *   1. BRAVE  (BRAVE_SEARCH_API_KEY)  — https://api.search.brave.com
 *   2. TAVILY (TAVILY_API_KEY)        — https://api.tavily.com
 *   3. MOCK   (no key)                — deterministic sample results so the
 *      whole flow is runnable/testable locally without credentials.
 *
 * Every adapter returns the SAME shape:
 *   [{ title, url, snippet, source }]
 * so the orchestrator and the Flutter SearchResultCard never care which
 * provider answered.
 */
const TIMEOUT_MS = 10_000;

async function braveSearch(query, maxResults) {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) return null;
  const u = new URL("https://api.search.brave.com/res/v1/web/search");
  u.searchParams.set("q", query);
  u.searchParams.set("count", String(maxResults));
  const r = await fetch(u, {
    headers: { "X-Subscription-Token": key, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`brave ${r.status}`);
  const data = await r.json();
  return (data.web?.results || []).slice(0, maxResults).map((w) => ({
    title: w.title || "",
    url: w.url || "",
    snippet: (w.description || "").replace(/<[^>]+>/g, ""),
    source: hostOf(w.url),
  }));
}

async function tavilySearch(query, maxResults) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return null;
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      api_key: key,
      query,
      max_results: maxResults,
      include_answer: false,
    }),
  });
  if (!r.ok) throw new Error(`tavily ${r.status}`);
  const data = await r.json();
  return (data.results || []).slice(0, maxResults).map((w) => ({
    title: w.title || "",
    url: w.url || "",
    snippet: String(w.content || "").slice(0, 300),
    source: hostOf(w.url),
  }));
}

/** Keeps the app fully runnable with zero external keys. */
function mockSearch(query, maxResults) {
  return Array.from({ length: Math.min(3, maxResults) }, (_, i) => ({
    title: `Sample result ${i + 1} for "${query}"`,
    url: `https://example.com/search?q=${encodeURIComponent(query)}&r=${i + 1}`,
    snippet:
      `This is a mock search result. Set BRAVE_SEARCH_API_KEY or ` +
      `TAVILY_API_KEY on the backend to get live web results for "${query}".`,
    source: "example.com",
  }));
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_) {
    return "";
  }
}

/**
 * @returns {Promise<{results: Array, provider: string}>}
 */
async function search(query, maxResults = 5) {
  const q = String(query || "").trim().slice(0, 400);
  const n = Math.max(1, Math.min(10, Number(maxResults) || 5));
  if (!q) return { results: [], provider: "none" };

  const chain = [
    ["brave", braveSearch],
    ["tavily", tavilySearch],
  ];
  for (const [name, fn] of chain) {
    try {
      const results = await fn(q, n);
      if (results) return { results, provider: name };
    } catch (e) {
      console.warn(`search: ${name} failed — ${e.message}`);
    }
  }
  return { results: mockSearch(q, n), provider: "mock" };
}

module.exports = { search };
