/**
 * EMBEDDING SERVICE — provider abstraction (§17).
 *
 * The application must not be welded to one vendor, and it must keep
 * working when no provider is configured. Contract:
 *
 *   embed(texts) -> number[][] | null
 *
 * `null` means "no embeddings available" — every caller degrades to the
 * lexical path rather than failing. Nothing here fabricates a vector.
 *
 * STORAGE FORMAT: plain JSON float arrays in `agent_memories.embedding` /
 * `document_chunks.embedding`. This migrates to pgvector with a single
 * `ALTER TABLE … USING (embedding::text::vector)` because the JSON array
 * literal `[0.1,0.2,…]` is exactly pgvector's input syntax. See
 * RECOMMENDED PRODUCTION CONFIG below.
 *
 * RECOMMENDED PRODUCTION CONFIG:
 *   image: pgvector/pgvector:pg16   (drop-in replacement for postgres:16)
 *   CREATE EXTENSION vector;
 *   ALTER TABLE agent_memories ALTER COLUMN embedding TYPE vector(768)
 *     USING (embedding::text::vector);
 *   CREATE INDEX ON agent_memories USING hnsw (embedding vector_cosine_ops);
 * The retrieval API does not change; only the ranking moves into SQL.
 */

const PROVIDERS = {
  /** Google Gemini embeddings — same key as the rest of the app. */
  gemini: {
    available: () => Boolean(process.env.GEMINI_API_KEY),
    dims: 768,
    async embed(texts) {
      const model = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001";
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": process.env.GEMINI_API_KEY,
          },
          signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({
            requests: texts.map((t) => ({
              model: `models/${model}`,
              content: { parts: [{ text: t }] },
              outputDimensionality: 768,
            })),
          }),
        }
      );
      if (!r.ok) throw new Error(`gemini embed ${r.status}`);
      const j = await r.json();
      return (j.embeddings || []).map((e) => e.values);
    },
  },

  /** OpenAI-compatible endpoint (also covers local Ollama / LM Studio). */
  openai: {
    available: () => Boolean(process.env.OPENAI_API_KEY),
    dims: 1536,
    async embed(texts) {
      const base = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
      const r = await fetch(`${base}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          model: process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small",
          input: texts,
        }),
      });
      if (!r.ok) throw new Error(`openai embed ${r.status}`);
      const j = await r.json();
      return (j.data || []).map((d) => d.embedding);
    },
  },
};

function activeProvider() {
  const want = String(process.env.EMBEDDING_PROVIDER || "").toLowerCase();
  if (want && PROVIDERS[want]?.available()) return { name: want, ...PROVIDERS[want] };
  for (const [name, p] of Object.entries(PROVIDERS)) {
    if (p.available()) return { name, ...p };
  }
  return null;
}

/**
 * Embeds one or more strings. Returns null (never throws, never fakes)
 * when no provider is configured or the call fails.
 */
async function embed(input) {
  const texts = (Array.isArray(input) ? input : [input])
    .map((t) => String(t || "").slice(0, 8000))
    .filter(Boolean);
  if (!texts.length) return null;

  const p = activeProvider();
  if (!p) return null;
  try {
    const out = await p.embed(texts);
    if (!Array.isArray(out) || out.length !== texts.length) return null;
    return out;
  } catch (e) {
    console.warn("embedding failed, falling back to lexical:", e.message);
    return null;
  }
}

/** Convenience for a single string. */
async function embedOne(text) {
  const out = await embed(text);
  return out ? out[0] : null;
}

function providerName() {
  return activeProvider()?.name || "none";
}

module.exports = { embed, embedOne, providerName, activeProvider };
