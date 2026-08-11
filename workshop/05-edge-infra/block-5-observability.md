# Block 5 — Cluster Observability

**Duration:** 45 min

**Goal:** See what's running on the edge and cloud Kubernetes clusters and whether
the data services (RisingWave, TimescaleDB, Redpanda) are healthy — using
`kube-prometheus-stack` (Prometheus + Grafana) and `k9s`.

---

## Why this block

Up to now you've checked health service-by-service — `kubectl logs`, a `psql`
query, the Redpanda Console. That works for one pod but doesn't answer *"is the
whole cluster healthy, and what changed?"* This block adds two complementary
tools:

- **`k9s`** — a terminal UI for *what's deployed*: browse pods, deployments,
  events, and logs across every namespace at a glance. Zero cluster footprint
  (it's a local binary that talks to the API server).
- **`kube-prometheus-stack`** — Prometheus scrapes metrics; Grafana charts them.
  This is the *is-it-healthy-over-time* layer: node CPU/memory, pod restarts,
  RisingWave barrier latency (streaming freshness), TimescaleDB connections,
  Redpanda throughput.

The two clusters differ in how the stack gets installed, so each has its own
section below.

!!! note "Node sizing"
    The edge K3s nodes are **t3.xlarge** (4 vCPU / 16 GiB) specifically so a
    node can run the data stack *and* a trimmed monitoring stack. On the shared
    EKS cluster there's ample headroom, so the cloud install keeps Alertmanager
    and persistent storage; the edge install drops both.

---

## Part A — Edge cluster (K3s)

### Prerequisites — reconnect to the edge cluster

Same SSM tunnel as Block 3 / Block 4 — reopen it if you're in a fresh terminal:

```bash
mkdir -p ~/.kube
aws ssm get-parameter \
  --name /workshop/ws-slot00/kubeconfig \
  --with-decryption \
  --query Parameter.Value \
  --output text > ~/.kube/edge-config
export KUBECONFIG=~/.kube/edge-config

K3S_SERVER_ID=$(aws iot list-things-in-thing-group \
  --thing-group-name ws-slot00-devices \
  --query "things" --output text | tr '\t' '\n' | sort | head -1)

aws ssm start-session \
  --target "$K3S_SERVER_ID" \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["6443"],"localPortNumber":["6443"]}' \
  > /tmp/k3s-ssm-pf.log 2>&1 &
SSM_PF_PID=$!
sleep 8

sed -i.bak -E 's#server: https://[0-9.]+:6443#server: https://127.0.0.1:6443#' \
  ~/.kube/edge-config

kubectl get nodes
# When finished with the edge cluster: kill "$SSM_PF_PID"
```
<!-- e2e:assert {"contains": "Ready"} -->

### Step 1 — Install kube-prometheus-stack (trimmed)

The edge install uses `helm/monitoring-values-edge.yaml`, which drops
Alertmanager and persistence and keeps a short 24h Prometheus retention so the
observability release never starves the workloads it watches.

??? example "View source — edge monitoring override values"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/helm/monitoring-values-edge.yaml){ .md-button target=_blank }

    ```yaml
    --8<-- "helm/monitoring-values-edge.yaml:edge-monitoring-values"
    ```

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update prometheus-community

helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  -f helm/monitoring-values-edge.yaml \
  --wait --timeout 10m
```
<!-- e2e:assert {"contains": "monitoring"} -->

This brings up Prometheus, Grafana, node-exporter, kube-state-metrics — **and**
the `monitoring.coreos.com` CRDs (`PodMonitor` / `ServiceMonitor`) that the next
step depends on.

### Step 2 — Enable the edge-stack monitors

The `edge-stack` chart ships PodMonitors/ServiceMonitors for RisingWave,
TimescaleDB, and Redpanda plus a curated Grafana dashboard, but they're
**off by default** — the chart is installed (Block 3) *before* the CRDs exist,
and rendering a monitor with no CRD present fails the install. Now that Step 1
installed the CRDs, re-run the release with monitoring turned on:

??? example "View source — the monitoring toggle in edge-stack values"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/helm/edge-stack/values.yaml){ .md-button target=_blank }

    ```yaml
    --8<-- "helm/edge-stack/values.yaml:edge-monitoring-toggle"
    ```

```bash
helm upgrade edge-stack ./helm/edge-stack \
  --namespace edge --reuse-values \
  --set monitoring.enabled=true
```
<!-- e2e:assert {"contains": "edge-stack"} -->

Confirm the monitors were created:

```bash
kubectl get podmonitors,servicemonitors -n edge
```
<!-- e2e:assert {"contains": "risingwave"} -->

### Step 3 — Open Grafana

No ingress — reach Grafana over an in-cluster port-forward (through the same SSM
tunnel), matching how you reach the HMI and Redpanda Console:

```bash
kubectl port-forward -n monitoring svc/monitoring-grafana 3001:80 \
  > /tmp/grafana-edge-pf.log 2>&1 &
GRAFANA_PF_PID=$!
until grep -q "Forwarding from" /tmp/grafana-edge-pf.log 2>/dev/null; do sleep 1; done
curl -sf -o /dev/null -w "%{http_code}\n" http://localhost:3001/login
kill "$GRAFANA_PF_PID" 2>/dev/null || true
```
<!-- e2e:assert {"contains": "200"} -->

Open **http://localhost:3001** in a browser (keep the port-forward running).
Log in with user `admin`, password `workshop`, then:

- **Dashboards → Edge Data Stack — Health** — the curated board: pod readiness,
  restarts, per-pod CPU/memory, RisingWave barrier latency, TimescaleDB backends.
- **Dashboards → Kubernetes / Compute Resources / Namespace (Pods)** — one of the
  stock kube-prometheus-stack boards for whole-cluster resource usage.

!!! tip "Rotate the password for anything but a demo"
    `adminPassword: workshop` is set in the values file for workshop convenience.
    For any non-throwaway cluster, remove it and let the chart generate a secret.

---

## Part B — Cloud cluster (shared EKS)

On the shared EKS cluster there is **one** Prometheus + Grafana for everyone,
installed cluster-scoped by `scripts/deploy-cloud-analytics.sh` (alongside
cert-manager and the operators) — so if you deployed your slot with that script,
**it's already running**. Each slot's `cloud-analytics` release emits its own
PodMonitors, which the shared Prometheus discovers, so every slot appears in the
same Grafana filtered by namespace.

??? example "View source — cluster-scoped monitoring install in the deploy script"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/scripts/deploy-cloud-analytics.sh){ .md-button target=_blank }

    ```yaml
    --8<-- "helm/monitoring-values-cloud.yaml:cloud-monitoring-values"
    ```

### Step 1 — Point kubectl at the shared cluster

```bash
aws eks update-kubeconfig --region us-east-1 --name workshop-eks
kubectl get pods -n monitoring
```
<!-- e2e:assert {"contains": "monitoring-grafana"} -->

If the `monitoring` namespace is empty, the cluster-scoped install hasn't run —
re-run `scripts/deploy-cloud-analytics.sh --deployment-id ws-slot00` (without
`--skip-cluster-scoped`), or install it by hand with
`helm/monitoring-values-cloud.yaml`.

### Step 2 — Confirm your slot's monitors exist

```bash
kubectl get podmonitors -n ws-slot00
```
<!-- e2e:assert {"contains": "risingwave-cloud"} -->

You should see the RisingWave PodMonitor and the CNPG-managed TimescaleDB
PodMonitor for your namespace.

### Step 3 — Open Grafana

```bash
kubectl port-forward -n monitoring svc/monitoring-grafana 3002:80 \
  > /tmp/grafana-cloud-pf.log 2>&1 &
GRAFANA_PF_PID=$!
until grep -q "Forwarding from" /tmp/grafana-cloud-pf.log 2>/dev/null; do sleep 1; done
curl -sf -o /dev/null -w "%{http_code}\n" http://localhost:3002/login
kill "$GRAFANA_PF_PID" 2>/dev/null || true
```
<!-- e2e:assert {"contains": "200"} -->

Open **http://localhost:3002** (admin / `workshop`) and find **Cloud
Analytics — Health (ws-slot00)**. Use the `namespace` dropdown at the top to
switch between slots and compare.

---

## k9s — browsing what's deployed

Grafana answers *is it healthy*; `k9s` answers *what's running, right now* far
faster than repeated `kubectl get`. Install it locally (it uses your current
`KUBECONFIG`, so it works against whichever cluster your tunnel/context points
at):

```bash
# macOS
brew install derailed/k9s/k9s
# or download a release binary: https://github.com/derailed/k9s/releases
k9s version
```
<!-- e2e:assert {"contains": "Version"} -->

Launch it against the edge cluster (tunnel open) or the cloud cluster:

```bash
k9s
```

Useful moves once inside:

- `:` then a resource name — `:pods`, `:deployments`, `:events`, `:podmonitors`.
- `0` — show all namespaces; type to filter.
- Select a pod and press `l` for logs, `d` to describe, `s` for a shell.
- `:xray deployments` — a tree of a deployment down to its pods and containers.

---

## Wrap-Up

You now have both a *what's-deployed* view (`k9s`) and a *health-over-time* view
(Grafana) for each cluster:

```
Edge K3s      → kube-prometheus-stack (trimmed) → Grafana "Edge Data Stack — Health"
Shared EKS    → kube-prometheus-stack (shared)   → Grafana "Cloud Analytics — Health", per-namespace
Both          → k9s (local binary, current kubeconfig)
```

The RisingWave **barrier-latency** panel is the one to watch during Session 6's
network-failure simulation — it's the streaming-freshness signal that spikes
when compute stalls, the same story the data-freshness panel tells from the
application side.
