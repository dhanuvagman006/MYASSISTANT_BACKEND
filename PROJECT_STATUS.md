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
2. **Provider chain** — `src/services/ai/router.js` now runs a two-provider
   chain (Groq Llama 3.3 70B first for latency, Gemini 2.0 Flash fallback;
   order via `AI_PROVIDER_ORDER`). The Section-5 two-provider contract item
   is SATISFIED. (This entry previously said "Gemini only" and went stale —
   corrected 07 Aug 2026.)
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

7. **SEMANTIC MEMORY RECALL (Aug 2026)** — memories are now retrieved by MEANING,
   not dumped in category order (see RESEARCH_AND_ROADMAP.md for the research
   behind this):
   - Every memory row gets a 768-dim `gemini-embedding-001` vector
     (multilingual — Kannada/Hindi facts rank correctly), stored as JSON text
     in a new `memories.embedding` column (auto-migrated; no pgvector needed).
   - `/chat` and `/chat/stream` embed the user's utterance IN PARALLEL with the
     intent tools, then `buildMemoryPrompt` cosine-ranks facts in Node so the
     2200-char budget is spent on what's relevant to THIS question. Profile
     facts (name, city) are always included; embeddings are written
     fire-and-forget on save and lazily backfilled for old rows.
   - Bulletproof fallback: no key / timeout / `MEMORY_SEMANTIC=off` → exact
     pre-existing category-order behavior. Zero new dependencies.
   - Tests: `scripts/memory-semantic-test.js` (pure unit, no DB/network, first
     in `npm test`); ranking + fallback also verified end-to-end against live
     Postgres during development.

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

## Update — 29 July 2026 (2): Monetization + hardening
**Billing (the money-maker):**
- **`src/billing/plans.js`** — Free (20 chats/day, 5 vision, 10 docs, 0 agent
  min) / Pro ₹249 (unlimited chat+STT, 50 vision, 100 docs, 30 agent min) /
  Family ₹499 (Pro-level ×5 seats, 60 POOLED agent minutes). 31 days/payment.
- **`src/billing/store.js`** — subscriptions, O(1) usage counters
  (user,kind,period UPSERTs — tiny at any scale), families (invite codes,
  seat caps, one-family-per-user), idempotent payments ledger, admin stats.
  Effective plan: own sub → family owner's sub → free; expiry checked on
  read (no cron). Agent minutes pool across the whole family, owner included.
- **`src/billing/razorpay.js`** — PAYMENT LINKS (UPI/cards/netbanking; no
  auto-debit mandate — app nudges renewal). Webhook verified by
  X-Razorpay-Signature over the RAW body (captured via express.json verify
  hook). Links expire in 30 min so stale prices can't be paid.
- **`src/billing/routes.js`** — GET /billing (plan+usage+family), POST
  /billing/checkout → hosted page URL, POST /billing/webhook
  (payment_link.paid → activate/renew, idempotent, renewals extend from
  expiry), family invite/join/leave. ENFORCEMENT middleware: 402
  {code:"limit_reached"} with a ready-to-SPEAK upsell line; dev/X-App-Key
  sessions never limited; /chat/greeting exempt.
- **Wiring** — /chat, /stt, /vision metered per-day; /agent-call gated on
  remaining minutes and metered from REAL BillDuration on the Plivo hangup
  webhook; /docs upload capped by plan (docs.countDocuments).

**Hardening:**
- **Per-user rate limit** (30/min by account) on /chat and /stt on top of
  the per-IP one — one hot account can't drain the AI quota for a NAT.
- **`src/routes/admin.js`** — GET /admin/stats behind X-Admin-Key
  (timing-safe; 404s while ADMIN_KEY unset — invisible). Counts only.
- **`scripts/backup.sh`** — WAL-safe `VACUUM INTO` DB snapshot + document
  files tarball, 14-archive retention; cron + ship to object storage.

**Tests** — `scripts/billing-test.js` (in `npm test`, auth ON with real
signed-up users): free limits visible, agent-call 402 for free, 20-then-402
chat metering, webhook bad-sig 403 / good-sig activation, idempotent
replays, renewal stacking, family invite→inherit, POOLED minute math,
join validation, admin key gate. ALL PASSING (3 suites, 21+ checks).

**Env additions**: RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET /
RAZORPAY_WEBHOOK_SECRET (webhook URL: /billing/webhook, event
payment_link.paid), ADMIN_KEY.

## Update — 30 July 2026: Feature-list audit sweep (F2, C4, D2, D3, D4, G2)
- **F2 — Privacy dashboard**: `src/routes/privacy.js` at `/privacy` (behind appAuth).
  `GET /export` → one JSON of everything (secrets redacted); `DELETE /account` →
  atomic cross-table transaction + doc files on disk + Google token revocation.
  Table list is discovered defensively via sqlite_master.
- **C4 — Unit conversion**: `src/services/tools/units.js` — deterministic
  (length/mass/volume/area incl. acre-cent-gunta/speed/data/temperature),
  wired into intents; zero network, zero AI cost.
- **D2 — Draft replies**: `POST /google/draft` + voice intent "reply to
  Ramesh's email saying…" — body composed by ONE dedicated AI call, draft
  saved deterministically in Gmail (NEVER sent; user reviews in Gmail).
  Needs the gmail.compose scope (app now requests it).
- **D3 — Calendar by voice**: `POST /google/event` + voice creation with a
  SPOKEN PREVIEW → yes/no confirm (2-min TTL pending map, same pattern as
  Swiggy; NOTE: move both Maps to Redis for multi-node). chrono-node parses
  the time on the user's clock; missing time → Hari asks instead of guessing.
  Needs the calendar.events scope. `updateEvent` helper ready for edits.
- **D4 — Meeting prep**: `GET /google/meeting-prep` + "prep me for my
  meeting" intent — next timed event + recent emails from ≤3 attendees,
  fetched in parallel.
- **G2 — Call preview & rules**: `agent_call_settings` table (master switch,
  daily limit, allowed hours) with GET/PUT `/agent-call/settings`;
  `POST /agent-call/preview` returns the exact opening line + rule verdict;
  `POST /agent-call` now enforces the rules server-side (403 with a
  ready-to-speak `say`). Billing 402 fires first by middleware order.
- **Tests**: `scripts/features-test.js` added to `npm test` — 4 suites, all
  passing (unit conversion exactness, export redaction, delete finality +
  dead login, rules/preview, google endpoint validation & honest 409s,
  intent-layer honesty while unlinked).

## Update — 30 July 2026 (2): Test-harness port fix + 45-feature audit
- **Fixed flaky tests**: features-test and billing-test both hardcoded port 3778
  (smoke 3999, agentcall 3777). A leftover listener made a suite silently talk to
  the WRONG server ("memory seeding" ghost failure). All four suites now grab a
  free ephemeral port via `scripts/_free-port.js`; verified passing when all four
  run CONCURRENTLY.
- **Audit vs the client's 45-feature list (Feature List PDF, 30 Jul)**:
  DONE — all of Phase 1 (A1–A5, B1–B4, C1–C5, D1–D4, E1–E3, F1–F3) and
  Phase 2 Group G (G1–G3 agent calls) + Swiggy ordering (extra, not in list).
  NOT BUILT — H1–H4 (automation), I1–I3 (smart home), J1–J3 (WhatsApp/social),
  K1–K4 (advisory: partially covered by chat, but no Account Aggregator, no
  professional directory), L1–L3 (price tracking / assisted purchase / UPI),
  M1 (offline model). These are the Months 5–9 items in the scope doc.

## Update — 3 Aug 2026: Prod config repair, Swiggy whitelist status, APK update channel
- **ROOT CAUSE of broken Swiggy connect + webhooks**: the k8s Secret
  `myassistant-secrets` was created with `--from-env-file=.env`, which does
  NOT strip inline `#` comments — several values were corrupted (e.g.
  `PUBLIC_BASE_URL` literally contained the comment text) and the Secret
  silently overrode the correct ConfigMap. Fixed live via `kubectl patch`:
  `PUBLIC_BASE_URL=https://api.hariassistant.tech`, stale ngrok
  `SWIGGY_REDIRECT_URI` removed, `DEFAULT_COUNTRY_CODE`/`PLIVO_FROM_NUMBER`/
  `APPLE_BUNDLE_ID` cleaned. ⚠ NEVER recreate the secret from a raw .env.
- **Secrets rotated** (values were exposed in a support chat):
  JWT_SECRET, ADMIN_KEY, APP_API_KEY, METRICS_TOKEN — done via patch.
  STILL OWED BY OWNER: Gemini key, Groq key, Google web client secret,
  GitHub PAT. `ALLOW_APP_KEY` left `true` pending an app-auth audit.
- **Swiggy MCP**: redirect fix worked — error moved from "Ngrok-free isn't
  whitelisted" to "**Hariassistant** isn't whitelisted": Swiggy now gates
  production access behind Builders Club approval (apply at
  mcp.swiggy.com/builders; localhost prototyping stays free). No code
  change can bypass this; DCR code may need a fixed client_id once approved.
- **Self-hosted app update channel** (`src/routes/appUpdate.js`):
  `POST /admin/apk` (X-Admin-Key, multipart: apk + versionCode/versionName/
  changelog[]) → stored in `DATA_DIR/apk/` on the PVC, sha256 computed,
  previous build pruned; `GET /app/latest.apk` public download;
  `GET /config` merges the uploaded build's version info + `apkUrl`/
  `apkSha256`. Verified end-to-end with a local express harness.
- **Deploy reality documented**: cluster runs `myassistant-backend:local`
  (NOT the ghcr.io CI image). Ritual: `docker build -t myassistant-backend:local .`
  → `docker save … | k3s ctr images import -` → `rollout restart`.
  TODO: either add KUBE_CONFIG secret to enable the CI deploy job, or
  switch the Deployment image to ghcr.io — one of the two, not the mix.

## NEXT (planned for tomorrow, 4 Aug)
- Rebuild + roll the backend image on the VPS (3-command ritual above) and
  verify: `/app/latest.apk` → 404 `no build published` proves new code live.
- Publish the first signed APK via `/admin/apk`; test full in-app OTA loop.
- Check Traefik request-body limit for ~60 MB APK uploads (add ingress
  annotation if the curl upload fails).
- Draft + submit Swiggy Builders Club application.
- Finish key rotation (Gemini/Groq/Google client secret/GitHub PAT).

7. **D-ID FACE MODE + VIDEO BRIEFINGS** (5 Aug 2026) — new `src/did/` module:
   - `POST /did/llm/v1/chat/completions` — OpenAI-compatible streaming bridge
     (per docs.d-id.com/docs/custom-llms). D-ID's avatar agents are created with
     `llm.type=custom` pointing here, so the FACE speaks with Hari's real brain
     (memory, docs, tools, regional language). Auth: `x-api-key = DID_LLM_KEY`
     + per-user signed `x-hari-user` header baked in at agent creation.
   - `POST /did/session` → per-user D-ID agent (lazy-created, stored in
     `did_agents`) + client key + signed page token → `{faceUrl}`.
   - `GET /did/face?t=…` — server-HOSTED face page (D-ID Agents Embed, brand
     styled) loaded by the app's WebView; restylable with a redeploy.
   - `GET|POST /did/briefing` — one avatar video per user per day (`did_briefings`):
     weather + reminders + headlines → one AI call writes a 60–90 word script →
     D-ID `/talks` renders it; app polls to `done` then plays `result_url`.
   - GATING: Face Mode + briefings are PRO (`effectivePlan`); the sign-up
     interview face session is free for everyone (one bounded wow moment).
   - Env: `DID_API_KEY`, `DID_LLM_KEY` (+ optional `DID_PRESENTER_SOURCE_URL`
     for a custom brand face, `DID_VOICE_ID`). Feature is invisible while unset.
   - ⚠️ Deploy notes: PUBLIC_BASE_URL must be a public HTTPS URL (D-ID calls
     back into /did/llm). Verify the embed script tag attributes against
     docs.d-id.com/docs/embed-quickstart on first run — D-ID versions the
     embed (`agent.d-id.com/v2/index.js`) and attribute names occasionally move.

## Update — 12 Aug 2026: Professional mode (client/patient case files) + document Send + ID recall
Backend feature work for a doctor/lawyer using the app with many clients, plus
"show my Aadhaar card → send it". All landed with tests; full suite green
against real Postgres (`npm test`).

- **New data model** (`src/db.js`): `clients` (name, kind patient|client|
  student|customer|other, phone, email, one-line summary, tags) and
  `client_notes` (dated). `documents` gained a nullable `client_id` link
  (idempotent `ALTER … ADD COLUMN IF NOT EXISTS`). Exported by
  `/privacy/export`, wiped by `/privacy/account`.
- **Store + routes**: `src/clients/store.js` (CRUD, dated notes, doc linking,
  full-profile read, and a fuzzy voice name-matcher tuned for STT messiness)
  and `src/routes/clients.js` (`/clients` REST, every case-file read audited).
  Deleting a client KEEPS the documents — they're unlinked, never destroyed.
- **Voice intents** (`src/services/intents.js`): three professional-mode
  intents — case-file recall ("give me the details about patient Ramesh":
  speaks profile + notes + doc text, pushes the documents to screen),
  deterministic note write ("note for patient Ramesh: …", auto-creates the card
  on first mention, refuses ambiguous names), and client list. When a client
  turn runs, the generic document search is skipped (the file already carries
  that person's docs).
- **ID documents / "show my Aadhaar card"**: `guessCategory` now recognises
  Aadhaar (incl. STT mishearings), PAN, passport, licence, voter/ration ID in
  English + Kannada/Hindi/Tamil/Telugu/Malayalam → category `id`; `docRecall`
  fires on those words; `searchDocuments` has an `id`-category fallback so the
  card surfaces even without a full-text hit. **Privacy**: when the top match is
  an ID, the recall prompt suppresses the full-text block and instructs the AI
  never to read the number aloud — show on screen, don't recite.
- **SSE fix**: the voice loop now emits a `documents` event so matched docs
  appear on screen during voice recall (previously `/chat` returned them but the
  voice path dropped them silently).
- **Bugs fixed**: `routes/docs.js` used a `memory` module it never required —
  every `DELETE /docs/:id` threw a ReferenceError and the post-analysis memory
  fact never saved (now imported; doc-delete also cleans its context fact via
  the new `memory.deleteFactsContaining`). The `smoke-test` referenced a
  removed key-value `/memory` API and failed even on untouched `main` — repaired
  to use the real survey/profile flow.
- **Tests**: new `scripts/clients-test.js` (22 assertions, stubbed DB/AI — no
  Postgres/keys needed) added to `npm test`; `smoke-test` extended with the
  clients API, an Aadhaar save→category check, and a doc-delete regression.

## NEXT
- Verify the Flutter side compiles locally (`flutter analyze`) — no Flutter SDK
  in the build env used for this change. Confirm `share_plus` resolves to 10.x
  (`Share.shareXFiles`); if pub picks 11.x, update that one call to
  `SharePlus.instance.share(ShareParams(files: …))`.
- Optional: let the client case-file screen link *existing* saved documents
  (backend already supports `POST /clients/:id/docs/:docId`).
