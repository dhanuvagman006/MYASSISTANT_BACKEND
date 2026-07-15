# MYASSISTANT Backend

Node.js + Express API server for the MYASSISTANT Android app.

## Endpoints
| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Uptime check |
| `GET /config` | none | Remote config: version info, changelog, feature flags, announcements |
| `POST /chat` | `X-App-Key` header | AI chat — `{messages:[{role,content}]}` → `{reply, sources}` |

## The update switchboard
`src/config/remoteConfig.js` controls what every installed app sees on launch:
feature flags, announcements, and version prompts. Edit + redeploy = instant
update for all users, no Play Store release. New AI capabilities ship here
on the server; the app is the window to them.

## Run locally
```
npm install
cp .env.example .env   # fill in your keys
npm run dev
```

## Deploy
Deploy to an **India region** (AWS ap-south-1 Mumbai / GCP asia-south1) per
the contract's data-residency commitment (Section 5.1). Any Node 20+ host
works: Railway, Render, EC2, Cloud Run.

## Security notes
- AI provider keys live only here, never in the APK.
- `APP_API_KEY` stops strangers from using your AI budget; replace with
  Google ID-token verification when sign-in (F1) is built.
- Rate-limited to 60 req/min/IP by default.
