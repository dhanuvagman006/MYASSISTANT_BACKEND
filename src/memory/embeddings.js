/**
 * MEMORY EMBEDDINGS (Gemini gemini-embedding-001)
 * -----------------------------------------------
 * Turns short memory facts and user utterances into 768-dim vectors so
 * recall can be ranked by MEANING (cosine similarity) instead of dumping
 * every fact into the prompt in category order.
 *
 * Design rules:
 *   • NEVER on the critical path failure-wise: every function returns null
 *     on any problem (no key, quota, timeout, bad response) and the caller
 *     falls back to the old non-semantic behavior.
 *   • Short timeout — a voice assistant would rather skip ranking than wait.
 *   • 768 dims via MRL truncation (quality sweet spot per Google docs);
 *     truncated vectors MUST be re-normalized for cosine to be valid.
 *   • Multilingual by design (100+ languages incl. Kannada/Hindi) — users
 *     speak to Hari in their own script and facts are stored that way.
 *   • MEMORY_SEMANTIC=off disables everything via env.
 */

const MODEL = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001";
const DIMS = 768;
const TIMEOUT_MS = 3_000;

function enabled() {
  return (
    String(process.env.MEMORY_SEMANTIC || "on").toLowerCase() !== "off" &&
    !!process.env.GEMINI_API_KEY
  );
}

function normalize(vec) {
  let norm = 0;
  for (const x of vec) norm += x * x;
  norm = Math.sqrt(norm);
  if (!norm || !Number.isFinite(norm)) return null;
  return vec.map((x) => x / norm);
}

/** Cosine similarity of two same-length numeric vectors; NaN-safe → -1. */
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return -1;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return Number.isFinite(dot) ? dot : -1; // vectors are pre-normalized
}

// Test seam: scripts can swap the network call for a deterministic fake.
let _embedImpl = null;
function setEmbedderForTests(fn) {
  _embedImpl = fn;
}

/**
 * Embed one short text. taskType steers the model:
 *   RETRIEVAL_DOCUMENT for stored facts, RETRIEVAL_QUERY for the question.
 * Returns a normalized number[] of length 768, or null on ANY failure.
 */
async function embedText(text, taskType = "RETRIEVAL_DOCUMENT") {
  const t = String(text || "").trim().slice(0, 1800);
  if (!t) return null;
  if (_embedImpl) return _embedImpl(t, taskType);
  if (!enabled()) return null;

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:embedContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({
          content: { parts: [{ text: t }] },
          taskType,
          outputDimensionality: DIMS,
        }),
      }
    );
    if (!r.ok) return null;
    const data = await r.json();
    const values = data?.embedding?.values;
    if (!Array.isArray(values) || values.length !== DIMS) return null;
    return normalize(values);
  } catch {
    return null;
  }
}

/**
 * Pure ranking: given memory rows (each may carry row.embedding as number[]
 * or a JSON string of one) and a normalized query vector, return rows sorted
 * most-relevant-first. Rows WITHOUT a usable embedding keep their original
 * relative order and sort AFTER all ranked rows (never lost, just last).
 * Does not mutate input. Safe when queryVec is null → returns rows as-is.
 */
function rankMemories(rows, queryVec) {
  if (!queryVec || !Array.isArray(rows) || rows.length === 0) return rows || [];
  const scored = rows.map((row, i) => {
    let vec = row.embedding;
    if (typeof vec === "string") {
      try { vec = JSON.parse(vec); } catch { vec = null; }
    }
    const score = Array.isArray(vec) ? cosine(vec, queryVec) : -Infinity;
    return { row, i, score };
  });
  scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));
  return scored.map((s) => s.row);
}

module.exports = { embedText, cosine, rankMemories, normalize, enabled, setEmbedderForTests, DIMS };
