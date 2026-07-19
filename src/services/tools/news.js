/**
 * NEWS TOOL — Google News RSS (free, no API key). Top headlines for the
 * user's region; optional topic search. 10-minute cache.
 */
const TIMEOUT = 8000;
const cache = new Map();
const TTL = 10 * 60 * 1000;

function decode(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

/**
 * @param {{topic?:string, lang?:string, country?:string, max?:number}} opts
 * @returns {Promise<{title:string, source:string}[]>}
 */
async function getHeadlines({ topic, lang = "en-IN", country = "IN", max = 6 } = {}) {
  const base = topic
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}`
    : "https://news.google.com/rss";
  const url = `${base}${base.includes("?") ? "&" : "?"}hl=${lang}&gl=${country}&ceid=${country}:${lang.split("-")[0]}`;

  const hit = cache.get(url);
  if (hit && Date.now() - hit.ts < TTL) return hit.data.slice(0, max);

  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`news ${r.status}`);
  const xml = await r.text();

  // Titles look like "Headline text - Source Name". Skip the feed title.
  const items = [];
  const re = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < 12) {
    const raw = decode(m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim());
    const dash = raw.lastIndexOf(" - ");
    items.push({
      title: dash > 0 ? raw.slice(0, dash) : raw,
      source: dash > 0 ? raw.slice(dash + 3) : "",
    });
  }
  cache.set(url, { ts: Date.now(), data: items });
  return items.slice(0, max);
}

function describe(items, topic) {
  if (!items || items.length === 0) return "";
  const head = topic ? `Top headlines about "${topic}":` : "Top headlines right now:";
  return (
    head + "\n" +
    items.map((h, i) => `${i + 1}. ${h.title}${h.source ? ` (${h.source})` : ""}`).join("\n")
  );
}

module.exports = { getHeadlines, describe };
