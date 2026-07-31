# Monitoring: Prometheus + Grafana + Loki + Alerts

One-time install (Helm 3 required):

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update

# Prometheus + Grafana + Alertmanager (single chart)
helm install kps prometheus-community/kube-prometheus-stack \
  -n monitoring --create-namespace \
  -f kube-prometheus-values.yaml

# Loki (log storage) + Promtail (log shipper on every node)
helm install loki grafana/loki-stack \
  -n monitoring \
  -f loki-values.yaml

# App-specific alert rules
kubectl apply -f alerts.yaml
```

Access Grafana locally:

```bash
kubectl -n monitoring port-forward svc/kps-grafana 3001:80
# open http://localhost:3001 — user: admin, password below
kubectl -n monitoring get secret kps-grafana -o jsonpath='{.data.admin-password}' | base64 -d
```

Loki is auto-added as a Grafana datasource by the loki-stack chart. In
Grafana → Explore → Loki, query the backend's logs with:

```
{namespace="myassistant", app="myassistant-backend"}
```

## What's monitored without any app changes

kube-prometheus-stack scrapes cAdvisor + kube-state-metrics, so you get
CPU, memory, restarts, pod status, and PVC usage for the backend out of
the box. The alerts in `alerts.yaml` are built only from these — no code
changes needed.

## Optional next step: app-level metrics

For request rate / latency / error-rate dashboards, add
`express-prom-bundle` to the app and expose `/metrics`, then create a
ServiceMonitor. Ask Claude to wire this when you're ready — deliberately
left out to keep this deployable today.
