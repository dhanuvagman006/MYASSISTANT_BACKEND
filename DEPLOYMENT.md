# Deployment Guide — MYASSISTANT_BACKEND on Kubernetes

End-to-end runbook. Prereqs: a Kubernetes cluster (GKE / EKS / DigitalOcean /
k3s all fine), `kubectl` pointed at it, and `helm` v3.

## 1. CI/CD (already wired)

`.github/workflows/ci-cd.yml` runs on every push/PR:

- **test** — `npm test` (self-contained smoke tests, no API keys)
- **build-and-push** — Docker image to `ghcr.io/dhanuvagman006/myassistant_backend`,
  tagged `sha-<commit>` and `latest` on main
- **deploy** (main only) — `kubectl set image`, waits for rollout, and
  **auto-rolls-back** to the previous revision if the rollout fails

To enable the deploy job, add one repo secret:

```bash
base64 -w0 ~/.kube/config   # paste output as secret KUBE_CONFIG
```

Make the GHCR package public (repo → Packages → package settings →
visibility) or add an imagePullSecret to the Deployment.

## 2. First deploy

```bash
kubectl apply -f k8s/00-namespace-config.yaml

# Create real secrets (see full command list in k8s/01-secret.example.yaml)
kubectl -n myassistant create secret generic myassistant-secrets \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=GEMINI_API_KEY="..." \
  --from-literal=GROQ_API_KEY="..."

kubectl apply -f k8s/10-deployment.yaml
kubectl -n myassistant get pods -w        # wait for Running 1/1
kubectl -n myassistant port-forward svc/myassistant-backend 3000:80
curl localhost:3000/health                # {"ok":true,...}
```

## 3. Ingress + HTTPS

Install ingress-nginx and cert-manager (commands in the header of
`k8s/30-ingress.yaml`), point your DNS A record at the ingress
LoadBalancer IP, edit the host + email in that file, then:

```bash
kubectl apply -f k8s/30-ingress.yaml
kubectl -n myassistant get certificate    # READY=True within ~2 min
```

Also update `PUBLIC_BASE_URL` in the ConfigMap to the real https URL
(OAuth callbacks and Plivo webhooks depend on it), then restart:
`kubectl -n myassistant rollout restart deploy/myassistant-backend`.

## 4. Autoscaling — read this first

The app now runs on Postgres (`k8s/05-postgres.yaml`), so the HPA is
safe to apply. Install Metrics Server first if the cluster lacks it:

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

Then: `kubectl apply -f k8s/40-hpa.yaml`. The Deployment already uses
RollingUpdate. Existing SQLite data can be imported with
`scripts/migrate-sqlite-to-postgres.js` (usage in the file header).
Note: the document-files PVC is ReadWriteOnce, so replicas co-locate on
one node; for multi-node scale-out move files to S3-compatible storage.

## 5. Monitoring, logs, alerts

See `k8s/monitoring/README.md` — three Helm commands install
Prometheus + Grafana + Alertmanager + Loki + Promtail, and
`alerts.yaml` adds app-specific alerts (backend down, crash-looping,
memory/CPU pressure, disk filling, backup failures). Point Alertmanager
at Slack/Telegram in `kube-prometheus-values.yaml`.

## 6. Backups & restore

```bash
kubectl apply -f k8s/50-backup-cronjob.yaml
# test immediately instead of waiting for tonight:
kubectl -n myassistant create job --from=cronjob/myassistant-db-backup backup-now
kubectl -n myassistant logs job/backup-now -f
```

Nightly at 03:00 IST it snapshots every SQLite DB with the safe
`.backup` API, gzips to a second PVC, keeps 14 days. **Restore:**

```bash
kubectl -n myassistant scale deploy/myassistant-backend --replicas=0
# run a temp pod mounting both PVCs, then:
#   gunzip -c /backups/users.db.<stamp>.gz > /data/users.db
kubectl -n myassistant scale deploy/myassistant-backend --replicas=1
```

For real DR, add S3/GCS upload at the marked line in the CronJob —
on-cluster backups don't survive cluster loss.

## 7. Rollback (manual)

CI rolls back automatically on failed rollouts. Manually:

```bash
kubectl -n myassistant rollout history deploy/myassistant-backend
kubectl -n myassistant rollout undo deploy/myassistant-backend            # previous
kubectl -n myassistant rollout undo deploy/myassistant-backend --to-revision=3
```

Note: rollback reverts code, not data. If a bad release corrupted the DB,
restore from the nightly backup as above.
