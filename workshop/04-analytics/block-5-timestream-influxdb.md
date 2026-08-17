# Block 5 — Amazon Timestream for InfluxDB: the Managed Hot Tier

**Duration:** 45 min

---

## Managed vs. self-managed — the same hot tier, two operating models

In [Block 4](block-4-timescaledb.md) you ran a **self-managed** hot store:
TimescaleDB on the cluster (CloudNativePG owns HA, failover, backups; you own the
operand image, the extension, the hypertable, and the continuous-aggregate SQL).
This block looks at the **managed** counterpart — **Amazon Timestream for
InfluxDB** — serving the *same* telemetry so you can compare them head-to-head on
the freshness dashboard in [Block 6](block-6-dashboard.md).

Both are purpose-built time-series **hot stores** from the on-disk substrate
introduced in [Block 1](block-1-storage.md): they serve recent history from disk
with sub-second-to-seconds freshness. The difference is not *what* they store but
*who operates them* and *what you trade* for that.

| | **TimescaleDB (Block 4)** | **Timestream for InfluxDB (this block)** |
|---|---|---|
| Operating model | Self-managed on EKS (CNPG operator) | AWS-managed instance (no nodes to run) |
| Data model | Relational — Postgres rows, one row per metric | Dimensional — measurement / tags / fields (below) |
| Query language | SQL (+ TimescaleDB functions) | Flux and InfluxQL (and SQL via the v3 engine) |
| Rollups | Continuous aggregates you define + refresh | Tasks / downsampling (or query-time `aggregateWindow`) |
| Freshness push | `LISTEN`/`NOTIFY` (used live in Block 6) | No push primitive we use here — **polled** in Block 6 |
| You operate | Image, extension, HA tuning, scaling, patching | Nothing — instance sizing is the only knob |
| Cost model | Instance runs 24/7 whether queried or not | Instance runs 24/7; managed premium, zero ops |

Neither is "better" — the point is that the **managed** store removes an entire
operational surface (the checkpoint/affinity/node-sizing failure modes you saw
RisingWave and TimescaleDB hit in
[Block 6](block-6-dashboard.md#data-store-performance-characteristics)) at the cost
of a push primitive and some control. You feel that trade directly: it is a
purpose-built time-series hot store serving from disk on a fully managed instance,
so it is the one live tier that needs **no** pod, PVC, operator, or affinity rule
on your cluster — but it is **polled, not pushed** (there is no `LISTEN`/`NOTIFY`
equivalent we use here). Zero ops in exchange for the loss of a push primitive and
some control.

---

## The InfluxDB dimensional data model

This is the store's defining strength, and where it diverges most from a
relational hot tier. InfluxDB does **not** model "one measurement per metric." A
point has four parts:

| Part | Role | Example |
|---|---|---|
| **measurement** | the *family* of the reading (like a table name) | `sensor_reading` |
| **tags** | indexed **identity** of the series (the "who/where") | `site_id=ws-slot00-edge-0`, `sensor=cpu_pct` |
| **fields** | the actual **value(s)** (not indexed) | `value=37.2` |
| **time** | the point's timestamp | `1723447800000` (epoch-ms) |

A **series** is one unique (measurement + tag-set) combination, and **series
cardinality** — the number of distinct tag-set combinations — is the primary thing
that governs an InfluxDB instance's memory and index cost. Keeping the metric name
in a **tag** (`sensor=cpu_pct`) rather than baking it into the measurement name
(`cpu_pct_reading`) is the idiomatic choice for two reasons: it keeps cardinality
bounded (new metrics add tag *values*, not new measurements), and it lets a single
query `GROUP BY` sensor across the whole fleet — exactly what the dashboard's fleet
aggregate needs.

This is the same normalisation TimescaleDB uses (`sensor_readings(sensor, site_id,
value, …)`, one row per metric), just expressed in InfluxDB's vocabulary — which
is why both tiers can answer the identical fleet-freshness question.

!!! info "One dimensional schema, two message shapes"
    Two kinds of message land on MSK: pre-normalised industrial sensor messages
    (`sensors.raw.*`, already `{sensor, site_id, value, ts_ms}`) and flat IoT node
    telemetry (`raw.telemetry`, `{thing_name, cpu_pct, mem_used_pct, …}`). The
    ingest agent maps the first straight onto `sensor_reading` and **fans the
    second out** — one `sensor_reading` point per numeric metric, tagged
    `site_id=<thing_name>`, `sensor=<metric>` — so both message shapes arrive under
    the *same* dimensional schema. The dimensional model is what lets two very
    different payloads collapse onto one queryable series space.

---

## How data gets in (and why freshness ≠ query latency)

TimescaleDB is fed by Redpanda Connect; the managed tier is fed by **Telegraf**,
InfluxData's own agent, reading the **same MSK topics**. Conceptually the path is
short: **MSK → Telegraf → line protocol** (`measurement,tag=v field=v timestamp`)
written to the per-slot bucket. Telegraf consumes the Kafka topics, maps the JSON
onto the dimensional model above, and writes points out on a flush interval.

Every point is timestamped with `ts_ms` — the IoT-Core **ingest** epoch-ms, the
same basis every other tier uses — so the freshness numbers on the dashboard are
clock-skew-free and apples-to-apples.

Keep two axes distinct when you reason about this tier:

- **Freshness** is an *ingestion-path* property: how long after a device publishes
  the point becomes visible. Here it is governed by Telegraf's flush interval plus
  the dashboard's poll cadence — roughly **1–2 s**. It has nothing to do with how
  hard the query is.
- **Query latency** is a *read-cost* property: how long a given read takes once the
  data is present. A `last()` per series is cheap; a wide `aggregateWindow`
  downsample over a long range is more expensive.

This is the same **read-complexity vs. write-complexity** trade the session keeps
returning to. Query-time downsampling with `aggregateWindow` pushes the work to
**read time** (cheap writes, you pay on every query); a Timestream for InfluxDB
**task / downsampling** — like a TimescaleDB continuous aggregate — pushes it to
**write time** (you maintain a rollup continuously, reads are then cheap). The
store lets you choose per query which side of that trade to pay on.

---

## Read the store's shape with Flux

The clearest way to *understand* a store is to query it. Point a Flux client at the
per-slot bucket and ask for the newest point per series — the same query shape the
dashboard's `/api/freshness?tier=influxdb` route runs. The instance is VPC-private,
so read its connection details from the in-cluster credentials Secret and reach it
over a short-lived port-forward:

```bash
# Connection details for the per-slot bucket (URL, token, org, bucket name).
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
```

Now ask for the newest point per series:

```bash
# Count series and show the most recent reading per (site_id, sensor).
curl -sf -k "https://localhost:8086/api/v2/query?org=${IX_ORG}" \
  -H "Authorization: Token ${IX_TOKEN}" \
  -H 'Accept: application/csv' \
  -H 'Content-Type: application/vnd.flux' \
  -d 'from(bucket:"'"$IX_BUCKET"'") |> range(start:-15m) |> filter(fn:(r)=> r._measurement=="sensor_reading" and r._field=="value") |> group(columns:["site_id","sensor"]) |> last()'
kill "$IX_PF_PID" 2>/dev/null || true
kubectl delete pod influx-q-$$ -n ws-slot00 --wait=false >/dev/null 2>&1 || true
```
<!-- e2e:assert {"contains": "sensor_reading"} -->

Read the pipeline left to right — it *is* the dimensional model in action:

1. `from(bucket:…) |> range(start:-15m)` — scan the last 15 minutes of the bucket.
2. `filter(… r._measurement=="sensor_reading" and r._field=="value")` — one
   measurement family, one field.
3. `group(columns:["site_id","sensor"])` — regroup by the two identity tags, i.e.
   one group **per series**.
4. `last()` — the newest point in each group.

Each CSV row is one series' latest point — `sensor_reading`, tagged by `site_id`
and `sensor`, with the `value` field and an RFC3339 `_time`. That's the managed
tier holding the identical fleet view TimescaleDB serves next door.

!!! tip "Flux vs. InfluxQL vs. SQL"
    Timestream for InfluxDB (v2 engine) speaks **Flux** (the pipe-forward
    functional language used above) and **InfluxQL** (a SQL-like dialect); the
    newer v3 engine adds native **SQL**. The dashboard uses Flux because its
    `last()` / `aggregateWindow` primitives express "newest point per series" and
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
