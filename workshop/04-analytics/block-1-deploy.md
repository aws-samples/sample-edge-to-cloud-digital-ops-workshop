# Block 1 — Inspect the Cloud Analytics Stack

**Duration:** 30 min

---

## What Got Deployed

The cloud analytics stack — RisingWave, TimescaleDB, the Redpanda Connect MSK→TimescaleDB pipeline, and the dashboard app — is deployed by a single admin command, folded into the sandbox bring-up you already ran:

```bash
scripts/deploy-cloud-analytics.sh --deployment-id ws-slot00
```

It is idempotent — every step is `kubectl apply` / `helm upgrade --install` / `CREATE ... IF NOT EXISTS`, so re-running it against an already-deployed slot is a no-op.

??? example "View source — deploy-cloud-analytics.sh"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/scripts/deploy-cloud-analytics.sh){ .md-button target=_blank }

    ```bash
    --8<-- "scripts/deploy-cloud-analytics.sh"
    ```

The script does two kinds of work:

| Kind | What | Who runs it |
|---|---|---|
| Cluster-scoped (once per EKS cluster) | Default `gp3` StorageClass, cert-manager, RisingWave operator, CNPG operator | Facilitator/CI (`--skip-cluster-scoped` for a namespace-only participant) |
| Per-slot | MSK credentials + topics, RisingWave S3 state bucket + IRSA ServiceAccount, `helm upgrade --install helm/cloud-analytics` | Everyone, once per slot |

The per-slot `helm upgrade --install` is what actually stands up the stack — everything above it in the script is prerequisite plumbing the chart assumes is already in place. This is the same "chart deploys the stores, admin script does the live-AWS wiring" split as the edge stack in Session 5.

---

## Confirm Your kubectl Access

```bash
aws eks update-kubeconfig --region us-east-1 --name workshop-eks
kubectl get pods -n ws-slot00
```
<!-- e2e:assert {"contains": "NAME"} -->

You should see pods for `risingwave-cloud-*`, `timescaledb-cloud-*`, `rp-connect-timescaledb-*`, and `cloud-analytics-dashboard-*` — all `Running`.

!!! info "Namespace-scoped access via IAM"
    If you're a participant without cluster-admin, your operations are scoped to your own namespace (`ws-slot00`) via `WorkshopParticipantRole-ws-slot00`, an IAM role with an EKS access entry limited to that namespace: run `aws eks update-kubeconfig --region us-east-1 --name workshop-eks --role-arn arn:aws:iam::000000000000:role/WorkshopParticipantRole-ws-slot00` instead, once your admin has granted your IAM identity `sts:AssumeRole` on that role.

---

## Inspect the Chart

`helm/cloud-analytics/` packages every piece as one release — the same pattern `helm/edge-stack/` uses for the edge tier:

??? example "View source — helm/cloud-analytics/values.yaml"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/helm/cloud-analytics/values.yaml){ .md-button target=_blank }

    ```yaml
    --8<-- "helm/cloud-analytics/values.yaml"
    ```

```bash
helm list -n ws-slot00
```
<!-- e2e:assert {"contains": "cloud-analytics"} -->

| Resource | What it is |
|---|---|
| `risingwave-cloud-*` | RisingWave CR (meta/frontend/compute/compactor), managed by the cluster-scoped operator |
| `timescaledb-cloud-*` | CNPG `Cluster` CR — 2-instance TimescaleDB, bootstraps the `sensor_readings` hypertable |
| `rp-connect-timescaledb-*` | Redpanda Connect pipeline: MSK `raw.telemetry`/`sensors.raw.*` → `sensor_readings` |
| `cloud-analytics-dashboard-*` | The dashboard app (Block 5) — Deployment + ClusterIP `Service`, no ingress |
| `<release>-rw-ddl` Job | Post-install/post-upgrade Job that applies `risingwave/ddl-cloud.sql` — see Block 2 |

A post-install/post-upgrade Job applies the RisingWave MV DDL automatically, reading MSK credentials from the in-cluster `msk-credentials` Secret rather than a hand-run `sed | psql`:

??? example "View source — risingwave-ddl-job.yaml"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/helm/cloud-analytics/templates/risingwave-ddl-job.yaml){ .md-button target=_blank }

    ```yaml
    --8<-- "helm/cloud-analytics/templates/risingwave-ddl-job.yaml"
    ```

```bash
kubectl get jobs -n ws-slot00 -l app.kubernetes.io/component=risingwave-ddl
```
<!-- e2e:assert {"contains": "rw-ddl"} -->

---

## Open the Dashboard

The dashboard is deployed in-cluster with no public endpoint — reach it with `kubectl port-forward`:

```bash
kubectl port-forward -n ws-slot00 svc/cloud-analytics-dashboard 3000:3000 > /tmp/dashboard-pf.log 2>&1 &
DASH_PF_PID=$!
until grep -q "Forwarding from" /tmp/dashboard-pf.log 2>/dev/null; do sleep 1; done
curl -sf http://localhost:3000 | head -c 200
kill "$DASH_PF_PID" 2>/dev/null || true
```
<!-- e2e:assert {"contains": "<"} -->

Or keep the port-forward running in a separate terminal and open `http://localhost:3000` in a browser. You should see the same three-tier freshness comparison described in Block 5 — RisingWave and TimescaleDB updating live, Athena on its slower on-demand cadence. Keep this open (or come back to it) as you work through Blocks 2–4, which explain *how* each tier gets its data.

---

## References

- [RisingWave Kubernetes Operator](https://docs.risingwave.com/deploy/risingwave-kubernetes)
- [CloudNativePG](https://cloudnative-pg.io/documentation/)
- [Redpanda Connect](https://docs.redpanda.com/redpanda-connect/)
