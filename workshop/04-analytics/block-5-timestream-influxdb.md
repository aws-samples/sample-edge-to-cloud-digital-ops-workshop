# Block 5 — Timestream for InfluxDB (Managed Hot Tier)

**Duration:** 45 min

---

## Managed vs. self-managed — the same hot tier, two operating models

In [Block 4](block-4-timescaledb.md) you ran a **self-managed** hot store:
TimescaleDB on the cluster (CloudNativePG owns HA, failover, backups; you own the
operand image, the extension, the hypertable, and the continuous-aggregate SQL).
This block deploys the **managed** counterpart — **Amazon Timestream for
InfluxDB** — serving the *same* telemetry so you can compare them head-to-head on
the freshness dashboard in [Block 6](block-6-dashboard.md).

This is the hands-on version of the **managed-vs-self-managed hot-tier** decision
in the SCADA storage guidance: both are purpose-built time-series stores with
sub-second-to-seconds freshness; the difference is who operates them and what you
trade for that.

| | **TimescaleDB (Block 4)** | **Timestream for InfluxDB (this block)** |
|---|---|---|
| Operating model | Self-managed on EKS (CNPG operator) | AWS-managed instance (no nodes to run) |
| Data model | Relational — Postgres rows, one row per metric | Dimensional — measurement / tags / fields (below) |
| Query language | SQL (+ TimescaleDB functions) | Flux and InfluxQL (and SQL via the v3 engine) |
| Rollups | Continuous aggregates you define + refresh | Tasks / downsampling (or query-time `aggregateWindow`) |
| Freshness push | `LISTEN`/`NOTIFY` (used live in Block 6) | No push primitive we use here — **polled** in Block 6 |
| You operate | Image, extension, HA tuning, scaling, patching | Nothing — instance sizing is the only knob |
| Cost model | Instance runs 24/7 whether queried or not | Instance runs 24/7; managed premium, zero ops |

Neither is "better" — the workshop's point is that a managed store removes an
entire operational surface (the checkpoint/affinity/node-sizing failure modes you
saw RisingWave and TimescaleDB hit in [Block 6](block-6-dashboard.md#data-store-performance-characteristics))
at the cost of a push primitive and some control. You feel that trade directly:
the InfluxDB tier is the one polled live tier that needs **no** pod, PVC, operator,
or affinity rule on your cluster.

---

## The InfluxDB dimensional data model

InfluxDB does **not** model "one measurement per metric." A point has four parts:

| Part | Role | Example |
|---|---|---|
| **measurement** | the *family* of the reading (like a table name) | `sensor_reading` |
| **tags** | indexed **identity** of the series (the "who/where") | `site_id=ws-slot00-edge-0`, `sensor=cpu_pct` |
| **fields** | the actual **value(s)** (not indexed) | `value=37.2` |
| **time** | the point's timestamp | `1723447800000` (epoch-ms) |

A **series** is one unique (measurement + tag-set) combination. Keeping the metric
name in a **tag** (`sensor=cpu_pct`) rather than baking it into the measurement
name (`cpu_pct_reading`) is the idiomatic choice: it keeps cardinality bounded and
lets a single query `GROUP BY` sensor across the whole fleet — exactly what the
dashboard's fleet aggregate needs.

This is the same normalisation TimescaleDB uses (`sensor_readings(sensor, site_id,
value, …)`, one row per metric), just expressed in InfluxDB's vocabulary — which
is why both tiers can answer the identical fleet-freshness question.

!!! info "One dimensional schema, two message shapes"
    Two kinds of message land on MSK: pre-normalised industrial sensor messages
    (`sensors.raw.*`, already `{sensor, site_id, value, ts_ms}`) and flat IoT node
    telemetry (`raw.telemetry`, `{thing_name, cpu_pct, mem_used_pct, …}`). Telegraf
    maps the first straight onto `sensor_reading` and **fans the second out** —
    one `sensor_reading` point per numeric metric, tagged `site_id=<thing_name>`,
    `sensor=<metric>` — so both arrive under the *same* schema as the sensors. See
    the `starlark` processor in the config below.

---

## How data gets in: MSK → Telegraf → line protocol

TimescaleDB is fed by Redpanda Connect; the managed tier is fed by **Telegraf**,
InfluxData's own agent, reading the **same MSK topics**. Telegraf's
`kafka_consumer` inputs consume the topics, its parsers map JSON onto the
dimensional model above, and its `outputs.influxdb_v2` writes **line protocol**
(`measurement,tag=v field=v timestamp`) to the per-slot bucket.

Every point is timestamped with `ts_ms` — the IoT-Core **ingest** epoch-ms, the
same basis every other tier uses — so the freshness numbers on the dashboard are
clock-skew-free and apples-to-apples.

??? example "View source — Telegraf config (helm/cloud-analytics/templates/telegraf-config.yaml)"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/helm/cloud-analytics/templates/telegraf-config.yaml){ .md-button target=_blank }

    ```toml
    --8<-- "helm/cloud-analytics/templates/telegraf-config.yaml:telegraf-config"
    ```

---

## Shared instance, per-slot bucket, in-cluster token

The instance follows the **MSK precedent**: **one shared** Timestream for InfluxDB
instance for the whole account, with **per-slot isolation via a bucket** named
`workshop-<deploymentId>` (not one instance per slot). The CDK construct lives in
the platform stack:

??? example "View source — Timestream for InfluxDB instance (amplify/custom/platform-stack.ts)"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/amplify/custom/platform-stack.ts){ .md-button target=_blank }

    ```typescript
    --8<-- "amplify/custom/platform-stack.ts:influxdb-instance"
    ```

The instance is **VPC-private** (`publiclyAccessible: false`, cloud VPC only) and
Timestream for InfluxDB surfaces only an **admin username/password** — never a
token. But Telegraf's `influxdb_v2` output needs a **token**. So bucket + token
provisioning can't run from the deploy script (it can't reach the private
endpoint); it runs **in-cluster** as a Helm post-install hook Job that signs in
with the admin creds, creates the per-slot bucket, mints a scoped read/write
token, and writes it into the `influxdb-credentials` Secret that both Telegraf and
the dashboard consume. The Job is **token-stable** — if the Secret already exists
it reuses it rather than orphaning tokens on every upgrade.

```
Platform stack:  shared workshop-influxdb instance (private, admin user/pass in Secrets Manager)
                                   │
Helm post-install hook Job  ──────►│  POST /api/v2/signin  (admin)
(in-cluster, in-VPC)               │  create bucket workshop-ws-slot00
                                   │  mint read/write token
                                   ▼
                        k8s Secret: influxdb-credentials {INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG, INFLUX_BUCKET}
                            │                                   │
                            ▼                                   ▼
                    Telegraf sink (writes)          Dashboard InfluxDB tier (reads, Block 6)
```

---

## Verify the tier is live

Block 1 already deployed `helm/cloud-analytics` with the Telegraf sink enabled.
Confirm the provisioning Job minted the per-slot credentials and Telegraf is
running:

```bash
# The provision Job writes this Secret once the bucket + token exist.
kubectl get secret influxdb-credentials -n ws-slot00 \
  -o jsonpath='{.data.INFLUX_BUCKET}' | base64 -d; echo
kubectl get deploy cloud-analytics-telegraf -n ws-slot00 \
  -o jsonpath='{.status.readyReplicas} ready{"\n"}'
```
<!-- e2e:assert {"contains": "ready"} -->

The bucket should print as `workshop-ws-slot00` and Telegraf should report `1 ready`.

Now read the newest point straight from the bucket with a **Flux** query — the
same query shape the dashboard's `/api/freshness?tier=influxdb` route runs. Tunnel
to the private instance through a throwaway `socat` pod:

```bash
IX_URL=$(kubectl get secret influxdb-credentials -n ws-slot00 -o jsonpath='{.data.INFLUX_URL}' | base64 -d)
IX_TOKEN=$(kubectl get secret influxdb-credentials -n ws-slot00 -o jsonpath='{.data.INFLUX_TOKEN}' | base64 -d)
IX_ORG=$(kubectl get secret influxdb-credentials -n ws-slot00 -o jsonpath='{.data.INFLUX_ORG}' | base64 -d)
IX_BUCKET=$(kubectl get secret influxdb-credentials -n ws-slot00 -o jsonpath='{.data.INFLUX_BUCKET}' | base64 -d)
IX_HOST=$(echo "$IX_URL" | sed -E 's#^https?://##; s#:.*##')
kubectl run influx-q-$$ -n ws-slot00 --image=alpine/socat --restart=Never --command -- \
  socat TCP-LISTEN:8086,fork,reuseaddr "TCP:${IX_HOST}:8086" >/dev/null 2>&1 || true
kubectl wait --for=condition=Ready pod/influx-q-$$ -n ws-slot00 --timeout=60s >/dev/null 2>&1 || true
kubectl port-forward -n ws-slot00 pod/influx-q-$$ 8086:8086 > /tmp/ix-q-pf.log 2>&1 &
IX_PF_PID=$!
until grep -q "Forwarding from" /tmp/ix-q-pf.log 2>/dev/null; do sleep 1; done
# Count series and show the most recent reading per (site_id, sensor).
curl -sf -k "https://localhost:8086/api/v2/query?org=${IX_ORG}" \
  -H "Authorization: Token ${IX_TOKEN}" \
  -H 'Accept: application/csv' \
  -H 'Content-Type: application/vnd.flux' \
  -d 'from(bucket:"'"$IX_BUCKET"'") |> range(start:-15m) |> filter(fn:(r)=> r._measurement=="sensor_reading" and r._field=="value") |> group(columns:["site_id","sensor"]) |> last()' \
  | head -20
kill "$IX_PF_PID" 2>/dev/null || true
kubectl delete pod influx-q-$$ -n ws-slot00 --wait=false >/dev/null 2>&1 || true
```

Each CSV row is one series' latest point — `sensor_reading`, tagged by `site_id`
and `sensor`, with the `value` field and an RFC3339 `_time`. That's the managed
tier holding the identical fleet view TimescaleDB serves next door.

!!! tip "Flux vs. InfluxQL vs. SQL"
    Timestream for InfluxDB (v2 engine) speaks **Flux** (the pipe-forward
    functional language used above) and **InfluxQL** (a SQL-like dialect); the
    newer v3 engine adds native **SQL**. The dashboard uses Flux because its
    `last()`/`aggregateWindow` primitives express "newest point per series" and
    "downsample on read" more directly than InfluxQL — but the fleet question is
    the same one the TimescaleDB `GROUP BY` answers.

---

## Where this shows up next

- **[Block 6 — Live Analytics Dashboard](block-6-dashboard.md)** renders this tier
  as the 4th bar (`live · poll`, cyan) alongside RisingWave, TimescaleDB, and
  Athena, and its CLI section has a matching InfluxDB freshness block the e2e suite
  records.
- The **[decisions log](../reference/decisions.md)** captures why the tier is a
  shared instance with per-slot buckets, and why Telegraf (not a second Redpanda
  Connect pipeline) is the ingest path.
