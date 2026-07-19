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
