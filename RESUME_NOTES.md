# RESUME NOTES — session handoff (2026-07-31)

Working doc for Claude + Dhanu to resume. Read top-to-bottom for full state.

## What is DONE and verified

1. **Local k3s on the laptop** (Ubuntu, Inspiron 15-3515) runs the full stack:
   namespace `myassistant` (backend + Postgres) and `monitoring`
   (kube-prometheus-stack: Prometheus + Grafana + Alertmanager).
   - Backend reachable via `kubectl -n myassistant port-forward --address 0.0.0.0 svc/myassistant-backend 3000:80`
   - Grafana via `kubectl -n monitoring port-forward svc/kps-grafana 3001:80` → localhost:3001
   - Flutter app runs with `--dart-define=BASE_URL=http://<laptop-LAN-IP>:3000`
     (LAN IP changes with Wi-Fi — check `hostname -I`, first address).

2. **SQLite → Postgres migration: COMPLETE** (this branch, `postgres-migration`).
   - `src/db.js` rewritten on `pg` (pool, async helpers, ALL schemas in init()).
   - All 7 stores async: reminders, memory, google/tokens, agentcall,
     billing, swiggy/tokens, docs. All callers updated (routes, middleware,
     intents, extractor). FTS5 → tsvector GENERATED column + GIN, ts_rank.
   - privacy.js uses information_schema + real transactions.
   - server.js awaits db.init() before listen.
   - **All 4 test suites pass vs real Postgres** (smoke, agentcall, billing,
     features). Tests call scripts/_reset-db.js for fresh-DB semantics.
   - New: `k8s/05-postgres.yaml`, Deployment → RollingUpdate, HPA unblocked,
     docker-compose bundles postgres:16, and
     `scripts/migrate-sqlite-to-postgres.js` (id-preserving data import).

3. **Cluster wipe recovery**: the laptop cluster was wiped once (k3s reset).
   Rebuilt from manifests on THIS branch — the backend now runs Postgres
   locally. Monitoring reinstalled. Old SQLite data was not migrated
   (test data only).

## Environment quirks learned (do not rediscover these)

- The laptop's ISP mangles IPv6 to Docker/registries → image pulls die with
  "connection reset by peer". FIXED via `/etc/gai.conf` precedence line
  (IPv4 preferred). If pulls fail again: pull with docker, then
  `docker save <img> | sudo k3s ctr images import -`.
- Disabling IPv6 entirely breaks node-exporter/kube-state-metrics (they bind
  [::]) AND can wedge k3s networking → if pods can't reach 10.43.0.1:443,
  `sudo systemctl restart k3s`.
- kubectl on the laptop can't combine --from-env-file with --from-literal →
  append DATABASE_URL to a temp copy of .env instead.
- Backend image is LOCAL: build → `docker save | k3s ctr images import`,
  deployment uses `image: myassistant-backend:local`, `imagePullPolicy: Never`
  (already committed this way? NO — 10-deployment.yaml in git points at ghcr;
  the local-image sed is applied by hand after checkout. Consider a
  kustomize overlay later.)
- Grafana admin: user `admin`, initial password `change-me-on-first-login`
  (from kube-prometheus-values.yaml) — user sets real one on first login.
- Port 3000 = backend forward, 3001 = Grafana forward. Kill stale forwards
  with `sudo fuser -k 3000/tcp`.

## NEXT TASK: two-VPS production hosting (ARCHITECTURE REVISED by user)

- VPS-1: k3s cluster — backend + Postgres + ingress (THIS repo).
  Exposes metrics: backend /metrics (express-prom-bundle, METRICS_TOKEN
  bearer auth) + node-exporter DaemonSet on hostPort 9100 (firewall to
  monitoring VPS IP only).
- VPS-2: plain Docker Compose — separate repo MYASSISTANT_MONITORING
  (Prometheus + Grafana + Alertmanager) scraping VPS-1 remotely.
  k8s/monitoring/ was REMOVED from this repo accordingly.
- Use k8s/30-ingress.yaml (ingress-nginx or built-in traefik + cert-manager)
  with real DNS: api.<domain> → VPS-1, grafana.<domain> too.
- Flannel with WireGuard backend for encrypted inter-node traffic.
- Firewall: only 80/443 public; 6443 + node ports restricted between VPS IPs.
- Set PUBLIC_BASE_URL to https://api.<domain>; update ConfigMap.
- Postgres backups: adapt k8s/50-backup-cronjob.yaml (currently sqlite-era —
  needs rewrite to pg_dump). ← REMEMBER THIS.
- WAITING ON USER: which provider (DigitalOcean tab seen), RAM per VPS
  (decides if Loki fits), domain name, whether servers exist yet.

## Open items / nice-to-haves backlog

- [ ] 50-backup-cronjob.yaml still assumes SQLite — rewrite for pg_dump.
- [ ] CI/CD (.github/workflows/ci-cd.yml) deploy job: needs KUBE_CONFIG
      secret for the new cluster once VPSes exist; tests in CI need a
      postgres service container + DATABASE_URL env. ← CI currently RED on
      this branch for that reason, most likely. Check!
- [ ] Merge `postgres-migration` → main after user reviews PR.
- [ ] app-level metrics: express-prom-bundle + /metrics + ServiceMonitor
      (monitoring/README mentions it) → real request/latency dashboards.
- [ ] Provision Grafana dashboards from git so they survive wipes.
- [ ] start.sh helper for the laptop's two port-forwards (offered, not built).
- [ ] Flutter release build: BASE_URL via --dart-define to the real domain
      once VPS is live; remove any cleartext HTTP needs.
- [ ] SECURITY: a GitHub PAT was pasted in chat earlier — user was told to
      revoke + regenerate. VERIFY it's revoked.

## How the user likes to work

Step-by-step, one command block at a time, they paste terminal output back.
Don't dump long docs on them; keep each turn to one action + "paste what
you see". They know their stack well — explain what commands do when asked,
don't over-explain unprompted.
