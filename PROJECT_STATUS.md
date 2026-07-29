# PROJECT_STATUS.md — MYASSISTANT_BACKEND (Node/Express)
_Handoff document · updated 16 July 2026 · read together with the same file in the `MYASSISTANT` app repo_

## What this is
API server for the MYASSISTANT ("Hari") Flutter app. Endpoints:
- `GET /health` — uptime check (also used by the app as a latency warm-up ping on wake word)
- `GET /config` — remote-config "update switchboard": version info, changelog, feature flags,
  announcements (edit `src/config/remoteConfig.js` + redeploy = instant change on all phones)
- `POST /chat` — `{messages:[{role,content}]}` → `{reply, sources, provider}`; guarded by
  `X-App-Key` / Google ID token middleware (currently bypassed via `AUTH_DISABLED=true` for dev)

## Done so far
1. **Dockerised** — `Dockerfile` (node:20-alpine, non-root, healthcheck), `docker-compose.yml`
   (`cp .env.example .env` → `docker compose up --build`), `.dockerignore`.
2. **Provider switch** — Anthropic removed at user's request; **Gemini only**
   (`GEMINI_API_KEY`, default model `gemini-2.0-flash`) in `src/services/ai/router.js`.
   ⚠️ The client contract (Section 5) requires TWO AI providers (primary + fallback) —
   a second provider must be re-added before delivery.
3. Verified locally: server boots, `/health` and `/config` respond correctly.
4. **GET /region** — regional language from the caller's IP (ip-api.com free tier, 10-min
   cache, private/LAN IPs fall back to the server's public IP). Indian state -> locale map
   (Karnataka=kn_IN etc.), country map otherwise. App calls it at startup in Auto mode —
   replaces the GPS-permission approach as PRIMARY (GPS boxes remain fallback in the app).
5. **Voice-friendly system prompt** — replies must match the user's language AND script,
   stay 1–3 spoken sentences, and contain no markdown/emoji/URLs (they are read by TTS).

6. **DOCUMENT MEMORY (client feature)** — the agent now remembers documents:
   - `POST /docs` (multipart file + optional user note, e.g. "doctor said take
     Metformin 500mg…") → file saved to `DATA_DIR/files/<uid>/`, ONE Gemini call
     extracts title/category/date/summary/tags, a context fact lands in /memory.
   - `GET /docs`, `GET /docs/:id/file`, `PATCH /docs/:id` (note), `DELETE /docs/:id`.
   - Recall is wired into the chat intent layer (`RE.docRecall` in intents.js):
     "show me the report of my last hospital visit" → SQLite **FTS5** BM25 search
     (zero extra AI calls at recall time), matched docs are injected into the
     system prompt (the AI recites the doctor's note) AND returned as a
     `documents` array on `/chat` and in the `done` line of `/chat/stream`,
     so the app pops the actual file up on screen during voice-to-voice.
   - Caps: 100 docs/user (oldest evicted, file deleted from disk too).

Last commit at time of writing: `3f51e39` on `main`.

## Environment (.env — never committed)
```
GEMINI_API_KEY=...            # required (aistudio.google.com)
GEMINI_MODEL=gemini-2.0-flash
APP_API_KEY=<long random>     # shared secret with the app
AUTH_DISABLED=true            # DEV ONLY — must be false in production
GOOGLE_WEB_CLIENT_ID=...      # for Google Sign-In (F1), later
PORT=3000                     # hosts like Render inject their own
```

## Run
```bash
cp .env.example .env   # fill keys
docker compose up --build      # or: npm install && npm run dev
curl localhost:3000/health
```

## Not done yet / roadmap
- **Deploy** — user plans Render (Dockerfile ready: New → Web Service → pick repo → add env vars;
  don't set PORT). Free tier sleeps after ~15 min (30–60 s cold start — bad for voice latency);
  production must be an **India region** per contract (AWS ap-south-1 / GCP asia-south1 —
  Render has no India region, so Railway/EC2/Cloud Run for prod).
- Re-add a second AI provider (contract requirement).
- Turn auth on for prod: `AUTH_DISABLED=false`, app to send `X-App-Key` (not wired in app yet),
  then migrate to Google ID-token verification (`src/middleware/auth.js` already supports it).
- Future endpoints per scope: briefing/calendar, inbox digest, documents/OCR, calling,
  smart home, memory store (keyed by Google `sub`).
- Optional: GitHub Actions to build/push the Docker image.

## Security notes for the next session
- A GitHub PAT was pasted into a previous chat and used for pushes; it must be **revoked/rotated**.
- Rate limit: 60 req/min/IP via express-rate-limit; helmet enabled; JSON body capped at 2 MB.

## Update — 19 July 2026: Per-user memory (personalization)
- **`src/memory/store.js`** — `memories` table (same SQLite DB). UNIQUE(user_id,key)
  → upsert, never duplicates. Cap 200/user; oldest AI fact evicted first,
  signup/user facts protected. `buildMemoryPrompt()` renders a ≤2.2k-char
  system-prompt block.
- **`src/memory/extractor.js`** — after every /chat reply, fire-and-forget AI call
  (same provider chain) extracts NEW durable facts as strict JSON. Guardrails:
  no moods/one-offs, no passwords/IDs/health, 15s per-user throttle, max 4 facts
  per exchange, every field re-validated before DB write.
- **`src/routes/memory.js`** (mounted at `/memory`, behind appAuth) —
  GET list · POST add ("user" source) · DELETE /:id · DELETE / clear-all.
  Dev/X-App-Key sessions get 400 (memory needs a real account).
- **`/chat`** now injects the user's memory block into the system prompt on every
  reply and triggers extraction after responding (never blocks the response).
- **Sign-up seeding** — email signup stores name+email; **Google sign-in stores
  name, given_name, email, photo, locale** from the verified ID token (refreshed
  every sign-in); Apple stores name+email.
- Tested end-to-end: signup seeding ✓, upsert dedupe ✓, delete/clear ✓, prompt ✓.

## Update — 19 July 2026 (2): Greeting endpoint
- **POST /chat/greeting** (behind appAuth) — AI-generated spoken hello built from
  the user's memory. <3 learned facts → greeting ends with ONE get-to-know-you
  question (the app opens the mic; the answer flows through /chat so the
  extractor learns). ≥3 facts → weaves in one personal touch instead.
  AI failure → static fallback still personalized with the user's first name.

## Update — 19 July 2026 (3): Interview support
- Auth responses include `isNew` (signup true; Google/Apple via upsertSocialUser
  now returning {user, created}; login false) → app shows one-time interview.
- **POST /memory/interview {question, answer}** — extractor runs immediately
  (`force` skips the 15s throttle, returns saved facts); raw-answer fallback
  keyed by question when extraction yields nothing.

## Update — 19 July 2026 (4): Assistant tools (intent layer)
- **`src/services/intents.js`** — runs before the AI on every /chat:
  · always injects current date/time in the user's timezone (X-TZ-Offset header)
  · "remind me…" → chrono-node parses the time on the USER'S clock, creates the
    reminder row deterministically, tells the AI to confirm (tested: "tomorrow
    at 5pm" IST → correct instant; "at 9 in the morning" rolls forward)
  · reminder listing, live weather (city in query > X-Geo-Lat/Lng headers >
    memory current_city), news headlines — injected as TOOL RESULT blocks the
    AI must answer from, phrased in the user's language.
- **`src/reminders/`** — store (SQLite, same DB) + CRUD routes at /reminders.
- **`src/services/tools/weather.js`** — Open-Meteo (keyless) + geocoding, WMO
  code → text, 10-min cache. **tools/news.js** — Google News RSS, 10-min cache.
  GET /tools/weather?lat&lng|city and /tools/news for the Today screen.
  (External APIs unreachable from the dev sandbox; verify once deployed.)
- deps: + chrono-node.

## Update — 19 July 2026 (5): Gmail + Calendar (read-only)
- src/google/tokens.js — google_tokens table; serverAuthCode → refresh token
  exchange (redirect_uri="" for mobile), access refresh w/ 60s slack, revoke on
  disconnect; clear re-consent error when Google omits refresh_token.
- src/google/api.js — recentEmails (primary, 3 days) + upcomingEvents + AI-text
  renderers. src/google/routes.js at /google: connect/status/DELETE/inbox/
  calendar (409 = not linked).
- Intents: email + calendar queries → live data; unlinked → AI points to the
  Connect button, never invents.
- Prod env: GOOGLE_WEB_CLIENT_SECRET; enable Gmail + Calendar APIs and both
  readonly scopes. Consent screen "Testing" = refresh tokens expire in 7 days;
  publish/verify for production. Only unlinked-state testable in sandbox.

## Update — 19 July 2026 (6): Indian-accent STT (Sarvam Saaras v3)
- /stt is now a provider chain: **SARVAM Saaras v3 first** (SARVAM_API_KEY;
  https://api.sarvam.ai/speech-to-text, api-subscription-key header, model
  saaras:v3 mode=transcribe) — built for Indian languages/accents/code-mix,
  en-IN first-class, 24 languages; our 16kHz mono m4a is its ideal input.
  language_code locked only on the user's explicit pick (ISO→BCP-47 map),
  else "unknown" auto-detect. **Groq Whisper large-v3 fallback** on any
  Sarvam failure/empty (also covers non-Indian languages). Response now
  includes provider. Either key alone works; no key → 503.
- Get a key at dashboard.sarvam.ai (free tier) → set SARVAM_API_KEY.

## Swiggy food ordering (added 27 Jul 2026)
Voice ordering via **Swiggy Builders Club MCP** (mcp.swiggy.com/builders).
- `src/swiggy/tokens.js` — per-user OAuth 2.1 + PKCE with Dynamic Client
  Registration and discovery (no client id to configure); refresh-token
  rotation handled; tokens in SQLite `swiggy_tokens`.
- `src/swiggy/mcp.js` — dependency-free Streamable-HTTP MCP client
  (per-user session cache, auto re-init on 404, token refresh on 401,
  SSE + JSON framing).
- `src/swiggy/order.js` — deterministic 2-turn flow: craving → address →
  OPEN restaurants → best-rated matching item (top-3 menus fetched in
  parallel) → cart → **spoken confirmation (2-min TTL)** → COD order →
  ETA. Guard rails: ₹1000 cap, place_food_order is NOT idempotent so a
  5xx checks get_food_orders before reporting failure.
- Intent wiring in `src/services/intents.js` — "order a pizza" / "I'm
  hungry" etc. trigger the flow; a bare "yes/no" (multilingual: haan,
  houdu, nahi, beda…) resolves a pending confirmation FIRST, before all
  other intents. All money moves in code; the AI only phrases results.
- Routes: `GET /swiggy/status`, `GET /swiggy/connect` (returns browser
  URL for phone+OTP), public `GET /swiggy/callback`, `DELETE /swiggy`.
- Env: `SWIGGY_MCP_BASE`, `SWIGGY_REDIRECT_URI` (see .env.example).
- E2E-tested against a local mock MCP server (search→cart→confirm→place,
  cancel path, closed-restaurant filtering all pass).
- TODO: app needs a "Connect Swiggy" button (call /swiggy/connect, open
  the URL); apply for Builders Club production access with a demo video.

## Update — 29 July 2026: Agent calls (AI talks on real phone calls)
"Call Allen Lobo and ask him at what time he will come home" — Hari
PLACES the call itself, speaks to the contact, converses until the task is
done, hangs up politely, and the app speaks the answer back.

**Telephony provider: PLIVO** (Twilio was implemented first, then REPLACED
at the user's request for India support). Why Plivo: it rents real Indian
(+91) numbers with DOMESTIC routing (requires an India-registered business
KYC, ~1 day — contacts then see a local caller ID, calls stay on Indian
trunks per TRAI media-anchoring). Before KYC, the same account reaches
Indian numbers over international routes (dev/testing) with the identical
code path. Twilio was rejected because it sells no Indian numbers and, per
Indian regulation (Aug 2024), +91→+91 caller IDs don't work over it.
Exotel was evaluated and rejected for now: its voicebot applet streams RAW
audio over WebSocket with no built-in STT/TTS (a much bigger build).

- **`src/agentcall/store.js`** — `agent_calls` table (unguessable hex ids,
  per-user, JSON transcript, result summary, `provider_call_id`; dev-DB
  migration renames the old `twilio_sid` column automatically).
- **`src/agentcall/plivo.js`** — SDK-free REST client (create call with
  `machine_detection=hangup`, hangup), E.164 normalization (10-digit → +91
  default, `DEFAULT_COUNTRY_CODE`), X-Plivo-Signature-V2 validation
  (HMAC-SHA256(url+nonce), timing-safe, multi-signature token rotation),
  Plivo XML builders: `<Speak>` nested inside `<GetInput inputType="speech">`
  (contact can talk over the prompt; silence falls through to `<Redirect>`
  so our handler always runs), Polly.Aditi for en-IN/hi-IN.
- **`src/agentcall/engine.js`** — call brain on the existing provider chain:
  openingLine / nextTurn (strict-JSON `{say,done}`) / summarize. EVERY step
  has a deterministic fallback so a dead AI never strands a live call; hard
  cap of 6 agent turns. Guardrails: AI discloses itself, no private info
  beyond the task, no commitments/payments on the user's behalf.
- **`src/agentcall/routes.js`** — app-facing `POST /agent-call` (503 when
  Plivo env unset → app falls back to direct dial), `GET /agent-call/:id`
  (ownership-checked poll); Plivo webhooks `/plivo/:id/{answer,input,hangup}`
  mounted BEFORE appAuth (server-to-server), each request authenticated by
  signature instead. Voicemail (machine cause on /hangup) → no_answer;
  double silence → graceful goodbye; early hangup → summarized anyway.
- **Env**: `PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`, `PLIVO_FROM_NUMBER`,
  `PUBLIC_BASE_URL` (all four required), optional `DEFAULT_COUNTRY_CODE=91`,
  `PLIVO_VALIDATE=false` (dev tunnels only). `/config` has
  `features.agent_calls`.
- **Tests** — `scripts/agentcall-test.js` (part of `npm test`): full webhook
  lifecycle with no AI keys (fallbacks) — 503 unconfigured, E.164,
  answer+GetInput, voicemail, reply→summary ("…around 7 30…"), poll,
  no-answer, early-hangup summary, validation, V2 signature check. PASSING.
- **India compliance note**: personal assistant calls to the user's own
  contacts are not commercial telemarketing, and the agent discloses itself
  on every call; for scale, review TRAI AI-calling rules (disclosure,
  consent, number series).
