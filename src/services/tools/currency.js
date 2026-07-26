/**
 * CURRENCY (C4) — live exchange rates via frankfurter.app (ECB data,
 * free, no API key). 1-hour cache — rates don't move faster than that
 * for conversational purposes, and it keeps us well under any limits.
 */
const cache = new Map();
const TTL = 60 * 60 * 1000;

const WORDS = {
  dollar: "USD", dollars: "USD", usd: "USD", buck: "USD", bucks: "USD",
  rupee: "INR", rupees: "INR", inr: "INR", "₹": "INR",
  euro: "EUR", euros: "EUR", eur: "EUR", "€": "EUR",
  pound: "GBP", pounds: "GBP", gbp: "GBP", "£": "GBP",
  yen: "JPY", jpy: "JPY", "¥": "JPY",
  dirham: "AED", dirhams: "AED", aed: "AED",
  riyal: "SAR", riyals: "SAR", sar: "SAR",
  "singapore dollar": "SGD", sgd: "SGD",
  "australian dollar": "AUD", aud: "AUD",
  "canadian dollar": "CAD", cad: "CAD",
  franc: "CHF", francs: "CHF", chf: "CHF",
  yuan: "CNY", cny: "CNY", rmb: "CNY",
  won: "KRW", krw: "KRW",
  baht: "THB", thb: "THB",
  ringgit: "MYR", myr: "MYR",
};

const CODE_RE = new RegExp(
  `\\b(${Object.keys(WORDS).sort((a, b) => b.length - a.length).join("|")})\\b`,
  "gi"
);

/** Detects a conversion ask; returns {amount, from, to} or null. */
function parseCurrencyAsk(msg) {
  const codes = [];
  let m;
  CODE_RE.lastIndex = 0;
  while ((m = CODE_RE.exec(msg)) && codes.length < 2) {
    const code = WORDS[m[1].toLowerCase()];
    if (!codes.includes(code)) codes.push(code);
  }
  if (codes.length < 2) return null;
  const amt = msg.match(/(\d[\d,]*(?:\.\d+)?)/);
  return {
    amount: amt ? parseFloat(amt[1].replace(/,/g, "")) : 1,
    from: codes[0],
    to: codes[1],
  };
}

async function getRate(from, to) {
  const key = `${from}:${to}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return hit.rate;
  const r = await fetch(
    `https://api.frankfurter.app/latest?from=${from}&to=${to}`,
    { signal: AbortSignal.timeout(6000) }
  );
  if (!r.ok) throw new Error(`fx ${r.status}`);
  const rate = (await r.json()).rates?.[to];
  if (!rate) throw new Error("fx: no rate");
  cache.set(key, { ts: Date.now(), rate });
  return rate;
}

module.exports = { parseCurrencyAsk, getRate };
