# MYASSISTANT Backend

Node.js + Express API server for **MYASSISTANT / "Hari"** — a voice-first
personal AI assistant (Flutter app in the `MYASSISTANT` repo). All AI provider
keys live here, never in the app: the app only ever carries the user's own JWT.

- **Runtime:** Node 20+ · Express 4 · PostgreSQL (via `pg`)
- **AI:** Gemini (chat, streaming, vision, STT) through `src/services/ai/router.js`
- **Realtime:** the voice loop runs over Server-Sent Events (`/assistant/*`)
- **Ops:** Helmet, per-IP + per-user rate limits, Prometheus metrics, Docker + k8s

## Data model (one place: `src/db.js` `init()`)
Every table is created idempotently at boot. User-owned data:
`users`, `agent_memories`, `reminders`, `bookings`, `documents`,
`clients` + `client_notes` (professional mode), `google_tokens`,
`actions_log` (audit), `kv`. All of it is exported by `/privacy/export` and
erased by `/privacy/account`.

## Endpoints
Auth column: **none** = public · **JWT** = `Authorization: Bearer <token>` from
`/auth/*` · a dev-only `X-App-Key` fallback exists when `ALLOW_APP_KEY=true`.

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Uptime check |
| `GET /metrics` | token | Prometheus metrics (guard with `METRICS_TOKEN`) |
| `GET /config` | none | Remote config: versions, changelog, feature flags, announcements, APK url |
| `POST /app/...` | none | Self-hosted OTA update channel (APK metadata) |
| `POST /auth/*` | none | Email + Google/Apple sign-in → issues the session JWT |
| `POST /chat` | JWT | AI chat — `{messages:[…]}` → `{reply, sources, documents}` |
| `POST /assistant/session` · `GET /assistant/stream/:sid` · `POST /assistant/:sid/*` | JWT | Realtime voice loop (SSE + mic/text/contacts/confirm) |
| `POST /stt` | JWT | Speech-to-text (Gemini Whisper-style) |
| `POST /vision` | JWT | Photo/PDF understanding (Gemini vision) |
| `GET/POST/PATCH/DELETE /docs` · `GET /docs/:id/file` | JWT | Saved documents — recall + the original file bytes |
| `GET/POST/PATCH/DELETE /clients` + `/clients/:id/notes` + `/clients/:id/docs/:docId` | JWT | **Professional mode** — per-patient/client case files |
| `GET/POST/PATCH/DELETE /reminders` | JWT | Reminders (also created by voice via chat intents) |
| `GET /profile` · `POST /profile/survey` | JWT | Onboarding survey → name/gender + seeded memories |
| `GET /actions` | JWT | The user's action audit log |
| `GET /privacy/export` · `POST /privacy/account` | JWT | Full data export · account erasure |
| `GET/POST /google/*` | JWT | Google link, Gmail (drafts only) + Calendar |
| `POST /avatar/*` | JWT | Tavus human-avatar video sessions |
| `GET /places` · `GET /tools/weather` · `GET /tools/news` | JWT | Live data for the Today screen |
| `GET /region` | none | Regional language guess from the caller's IP |
| `/admin/*` | `ADMIN_KEY` | Read-only ops stats + APK publish |

### Voice recall & professional mode
`src/services/intents.js` runs **before** the AI on every chat/voice turn. It
executes deterministic actions (reminders, calendar writes) and injects a live
data block the AI must answer from. It also powers:

- **Document recall** — "show me my last hospital report", "show my Aadhaar
  card". Matched documents are returned to the app (and pushed over SSE on the
  voice loop) so they appear on screen; the app's card has a **Send** button to
  share the real file. ID documents (Aadhaar/PAN/passport/licence/voter) are
  categorised from the save note and their numbers are never read aloud.
- **Client/patient case files** — "give me the details about patient Ramesh"
  speaks the profile + dated notes + linked documents and shows the files;
  "note for patient Ramesh: allergic to penicillin" writes a dated note
  (auto-creating the card on first mention); ambiguous names ask which person.

## The update switchboard
`src/config/remoteConfig.js` controls what every installed app sees on launch:
feature flags, announcements, version prompts, and the OTA APK url/hash. Edit +
redeploy = instant update for all users. New AI capabilities ship here on the
server; the app is the window to them.

## Run locally
```bash
npm install
cp .env.example .env          # fill in your keys (see below)
createdb myassistant          # or point DATABASE_URL at any Postgres 14+
DATABASE_URL=postgres://user:pass@localhost:5432/myassistant npm run dev
```

## Tests
```bash
npm test        # agents + clients + audit + smoke (needs a throwaway DATABASE_URL)
```
`scripts/smoke-test.js` boots the real server against an empty database and
exercises auth, memory, reminders, documents (incl. the Aadhaar/ID path) and
client case files. `agents-test`, `clients-test` and `audit-test` stub the DB
and AI, so they need no Postgres and no keys.

## Environment
Required: `DATABASE_URL`, `JWT_SECRET`, `GEMINI_API_KEY`.
Common: `PORT`, `DATA_DIR` (where document files live), `GEMINI_MODEL`,
`GEMINI_VISION_MODEL`, `CORS_ORIGIN`, `PG_POOL_SIZE`, `PUBLIC_BASE_URL`.
Auth/dev: `ALLOW_APP_KEY`, `APP_API_KEY`, `AUTH_DISABLED` (dev only — the
server refuses to boot with this in production), `GOOGLE_WEB_CLIENT_ID`,
`GOOGLE_WEB_CLIENT_SECRET`, `APPLE_BUNDLE_ID`.
Integrations: `GOOGLE_PLACES_API_KEY`, `TAVUS_API_KEY`, `TAVUS_FACE_ID`,
`TAVUS_PAL_ID`, `TAVUS_MAX_CALL_SECONDS`.
Ops: `ADMIN_KEY`, `METRICS_TOKEN`, `NODE_ENV`.

## Deploy
Deploy to an **India region** (AWS ap-south-1 Mumbai / GCP asia-south1) per the
contract's data-residency commitment (Section 5.1). Any Node 20+ host works
(Railway, Render, EC2, Cloud Run); `Dockerfile`, `docker-compose.yml` and `k8s/`
are included. Postgres replaces the old single-writer SQLite so the deployment
can scale horizontally behind the HPA.

## Security notes
- AI provider keys live only here, never in the app.
- Production auth is the session JWT; `X-App-Key` is a dev fallback gated by
  `ALLOW_APP_KEY` and `AUTH_DISABLED` is refused in production.
- Rate-limited per-IP (60/min default) and per-user.
- Every externally-visible or destructive action is written to `actions_log`
  (append-only; the user can read, export and erase it). Case-file reads are
  audited too — the confidentiality trail a doctor/lawyer needs.
- ⚠️ Never paste real keys or tokens into code, chats, or commits. If one leaks,
  rotate it immediately.
