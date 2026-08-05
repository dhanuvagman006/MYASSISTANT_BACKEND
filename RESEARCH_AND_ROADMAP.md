# RESEARCH_AND_ROADMAP.md — MYASSISTANT
_Autonomous research pass · 05 Aug 2026 · web research + codebase audit · read with PROJECT_STATUS.md_

## Scope of this pass
Web research (Aug 2026 sources) on: AI model strategy for voice agents, memory
architectures (Mem0 / Zep / Letta / roll-your-own), embeddings, and Indic TTS.
Decisions below were made against what THIS codebase already has, optimizing for
latency, cost (free tiers), privacy, and zero new infrastructure.

---

## 1. AI model strategy — VALIDATED, keep the chain

2026 industry guidance for voice agents converges on exactly the pattern this
backend already ships: a chained stack (STT → fast LLM → TTS) with the fastest
capable model first and a quality fallback. Groq's LPU inference (~320 tok/s on
Llama 3.3 70B, OpenAI-compatible) is repeatedly named the pick for
latency-sensitive voice UX, with Gemini Flash as the low-cost quality/long-context
complement. Streaming tokens into TTS is called out as the single biggest
perceived-latency win — we already stream (/chat/stream).

**Decision:** keep `AI_PROVIDER_ORDER=groq,gemini`. Two providers satisfies the
client contract.
**Optional third link (free, zero code):** Cerebras exposes an OpenAI-compatible
API (~1M free tokens/day, Llama 3.3 70B) — the Groq adapter works as-is with a
different base URL. Add only if 429s become common in production.
**Rejected:** OpenRouter as primary (adds a routing hop + platform fee; useful
later for model variety, not latency).

## 2. Memory — the gap, and what we built

**Audit finding:** memory recall was *not retrieval at all*. `buildMemoryPrompt`
dumped ALL facts in fixed category order into a 2200-char budget. At the
200-fact cap, whatever sorted last was silently cut, regardless of relevance to
the question. The assistant would "forget" exactly the fact you asked about.

**Frameworks researched:** Mem0 (~48K stars, vector-first personalization),
Zep/Graphiti (temporal knowledge graph, best LongMemEval accuracy), Letta
(OS-style tiered memory for long-running agents). All are strong, but all are
Python-first and bring infra (vector DB / graph DB / separate memory server).
For ≤200 facts per user, a full vector database is over-engineering; the honest
2026 guidance is "choose by access pattern, keep the raw store portable."

**Decision — implemented in this commit:** hybrid semantic recall, in-process.
- Every memory row gets a 768-dim embedding (`gemini-embedding-001`, free tier,
  100+ languages incl. Kannada/Hindi — matters for our users; MRL-truncated to
  768 and re-normalized).
- At chat time the user's utterance is embedded (kicked off in parallel with
  intent tools, so ~zero added wall-time) and facts are cosine-ranked in Node —
  200 × 768 floats is microseconds, no pgvector needed.
- Profile facts (name, city…) are ALWAYS included; ranked facts fill the rest of
  the budget; facts still awaiting embeddings are backfilled in the background.
- **Graceful degradation:** no key / quota / timeout → byte-identical to the old
  category-order behavior. `MEMORY_SEMANTIC=off` kills it via env.
- Store stays plain Postgres rows the user can list/delete (/memory, /privacy) —
  portable if we later migrate to Mem0/pgvector at real scale.

## 3. Voice roadmap — Indic TTS (next big UX win)

On-device Android TTS is the current ceiling. Research strongly favors
**Sarvam AI (Bulbul v3)** for our market: trained from scratch on 11 Indian
languages, blind-eval winner over ElevenLabs/Cartesia on Indic naturalness,
native Hinglish/code-switch handling, INR billing. ElevenLabs remains best for
English-first polish but has thin Kannada/Telugu/Malayalam coverage.
**Plan:** `POST /tts` endpoint, provider chain `sarvam → device-TTS fallback`,
app plays returned audio; gate behind a feature flag + paid key. (Deferred: needs
a funded Sarvam key to test.)

## 4. Feature backlog (classified)

| Feature | Class | Effort | Why |
|---|---|---|---|
| Semantic memory recall | Essential | done ✅ | Right fact at the right time |
| Cloud Indic TTS (/tts, Sarvam) | High Value | M | Voice quality = the product |
| Proactive daily brief (reminders+weather+news → push) | High Value | M | "Executive assistant" feel |
| Cerebras third provider | High Value | S | Free resilience |
| Gmail/Calendar via Google MCP-style OAuth tools | Premium | L | Busy-professional core |
| Episodic memory (conversation summaries w/ timestamps) | Premium | M | "What did I ask last week" |
| Rolling context summarization at turn ~10 | High Value | S | Latency + cost bound |
| On-device Gemma fallback (offline) | Experimental | XL | Privacy tier |

## 5. Security notes from this pass
- `AUTH_DISABLED=true` must be `false` before delivery (already flagged).
- The GitHub PAT used for this session was pasted in chat — **rotate it**.
- Embeddings send memory text to Google (same trust boundary as chat already
  sends full messages to Gemini — no new data class leaves the server).
