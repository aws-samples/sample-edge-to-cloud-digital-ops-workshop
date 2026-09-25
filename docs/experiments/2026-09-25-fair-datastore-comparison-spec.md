# Experiment spec — a fair, instrumented data-store comparison under load

**Status:** ready to execute · **Target slot:** `ws-slot42` · **Namespace:** `ws-slot42`
**Author of spec:** prepared for hand-off to a machine with live AWS creds + kubectl
**Deliverable this feeds:** the rewrite of `docs/blog/2026-09-09-loading-the-data-stores.md`

> **Written for:** an engineer running this from a *different* machine than the one that
> produced the current (flawed) numbers. You need live AWS credentials for the workshop
> account and a `kubectl` context on the workshop EKS cluster. No prior context from the
> chat session is assumed; everything needed is below.

---

## 1. Why we're re-running (what's wrong with the current blog)

The published freshness ramp "doesn't make sense" because the table compares numbers that
were **not measured the same way**. Six concrete defects, each of which this experiment fixes:

1. **The freshness metric conflates two things.** `freshness = now − MAX(ts_ms)` at *low*
   emit rates measures the **sensor sample interval**, not pipeline lag. At 114 msg/s the
   ~200 sensors emit at ~0.57 Hz, so the freshest reading is inherently up to ~1.75 s old
   *before it hits the wire*. At 9k+/s each sensor emits many times/second, so the latest
   reading is tens of ms old. That is why the column reads **backwards** (low rate looks
   worse). We must separate "emit cadence" from "pipeline lag."

2. **TSDB was re-measured; RisingWave and InfluxDB were not.** The current TimescaleDB
   column came from a clean, controlled, frac-scoped run on an empty table. The RisingWave
   and InfluxDB columns are **left over from an older run with the old (masked-MAX)
   methodology**. The side-by-side is invalid.

3. **Freshness and query-latency are different queries.** The TSDB *freshness* number is a
   **raw** hypertable read (`sensor_readings`, 15-min window); the TSDB *query-latency*
   number (~19 ms) is the **CAGG** read. At 63k/s a raw 15-min window is ~50 M rows and is
   **not** a 19 ms query on a 2-CPU/2-GiB box. One store, two unlabelled query paths.

4. **The metric is a near-metadata lookup.** `MAX(ts_ms)` barely exercises the read engine.
   A genuine analytical aggregation is a far better discriminator (see §6, Q4).

5. **Resources are not equal and the blog says they are.** The blog claims "all three sized
   to 4 vCPU / 32 GiB." Reality (from `helm/cloud-analytics/values.yaml`, confirmed live):

   | Store | CPU req / limit | Mem req / limit | Notes |
   |---|---|---|---|
   | RisingWave *compute* | 2000m / 3500m | 4Gi / 24Gi | + compactor, frontend, meta pods (~0.3–1.5 CPU) |
   | TimescaleDB | 500m / 2000m | 1Gi / 2Gi | primary only; standby doesn't serve reads |
   | Redpanda Connect (TSDB's committer) | **2 / 4 × 3 replicas** | 256Mi / 512Mi | dedicated ingest labor RW does *inside itself* |
   | InfluxDB | 100m / 500m | 128Mi / **256Mi** | absurdly small for a peer in the comparison |

   TimescaleDB effectively gets **its DB + 6–12 CPU of dedicated committer**; RisingWave does
   ingest *and* compute within ~2–3.5 CPU; InfluxDB is starved. The comparison is uncontrolled.

6. **No per-hop visibility.** We report end-to-end freshness but never show *where* the time
   goes (produce → broker → committer → insert → queryable). The blog needs this, with a
   visualization.

**Reframed question this experiment answers (the standing goal):**
> *What resources does each data store need to reach a reasonable performance limit, given
> its architecture, under a realistic frac-telemetry load — and where does the latency go?*
> Not "where does the store break."

---

## 2. Prerequisites & environment

- **AWS credentials** for the workshop account (the load generator resolves MSK via Secrets
  Manager and runs from pods *inside* the cloud VPC; you mainly need kubectl, but AWS creds
  are needed for any `aws` fallback and for the dashboard screenshot tooling).
- **kubectl** context on the workshop EKS cluster. Verify:
  ```bash
  kubectl get ns ws-slot42
  kubectl get pods -n ws-slot42 | grep -E 'timescaledb|risingwave|redpanda|influx|dashboard'
  ```
  Expect: `timescaledb-cloud-1` Running, `risingwave-cloud-compute-default-0` Running,
  3× `cloud-analytics-redpanda-connect-*` Running, `cloud-analytics-dashboard-*` Running.
- **Load-injection pods** already exist: `frac-load-big`, `frac-load-big2` … `frac-load-big6`
  (bare pods, one generator each). Confirm: `kubectl get pods -n ws-slot42 | grep frac-load-big`.
  Each must carry `/tmp/frac-runner.py` (from `docs/experiments/harness/`) + `/tmp/frac-msk-load.py`
  (from `simulator/`) — see `docs/experiments/harness/README.md` for the `kubectl cp` deploy step.
  If the pods are gone, recreate from `simulator/` (see §11).
- **Local tools on the running machine:** `python3` (stdlib only for the harness),
  `matplotlib` for the plots (`pip install matplotlib`), and — for the dashboard screenshot —
  `cd e2e && npx playwright install chromium` (see CLAUDE.md "Screenshotting the
  Cloud-Analytics Dashboard").
- **Repo branch:** `feat/frac-load-dashboard-timeseries-impl` (has the grid-alignment fix and
  the dashboard `Math.min` mask fix).

### Store access cheatsheet (namespace `ws-slot42`)

```bash
# TimescaleDB (Postgres) — primary
kubectl exec -n ws-slot42 timescaledb-cloud-1 -c postgres -- \
  psql -U postgres -d edge -A -t -c "SELECT 1;"

# RisingWave (pgwire on the frontend, user 'root', db 'dev')
kubectl exec -n ws-slot42 deploy/risingwave-cloud-frontend-default -- \
  psql -h localhost -p 4567 -d dev -U root -A -t -c "SELECT 1;"   # or port-forward 4567

# Committer config (live, may diverge from chart — see §9 divergence note)
kubectl get configmap rp-connect-timescaledb-config -n ws-slot42 -o yaml

# InfluxDB — see §6 Q4 for the Flux query path (influxdb rollup was provisioned)
```

> ⚠️ **Live-vs-chart divergence.** The `ws-slot42` stack was hand-patched during debugging:
> the committer configmap uses a **preserved consumer group** (not the chart's shared
> `timescaledb-sink`) to avoid MSK replay, the CAGG and `sensor_readings` table were
> **manually rebuilt** with a `deployment_id` column, and the committer Deployment carries a
> `maxSurge=0` strategy patch. A `deploy-cloud-analytics.sh` run would revert these. **Do not
> redeploy the chart mid-experiment** unless you first re-apply §4's changes on top.

---

## 3. Fairness controls (apply before measuring)

1. **Equalize compute/memory across the three ingest-path stores.** Decision to confirm with
   the blog author before running (see §10 open questions), but the default is:
   - Pin **RisingWave compute**, **TimescaleDB**, and **InfluxDB** to the **same** CPU and
     memory *limits* (proposal: **2 CPU / 8 GiB** each — the largest that fits the smallest
     store comfortably; TimescaleDB's `2Gi` today is the binding constraint, so raising all
     to a common 8 GiB is the fair move, not lowering RW to 2 GiB).
   - **Count the Redpanda Connect committer against TimescaleDB's budget** in the write-up:
     it is TSDB-specific ingest labor. Either (a) subtract its CPU from TSDB's allowance, or
     (b) state the asymmetry explicitly in the blog. RisingWave and InfluxDB ingest *inside*
     their own limits.
   - Apply via `helm/cloud-analytics/values.yaml` (`risingwave.resources.compute`,
     `timescaledb.resources`, `influxdb.resources`) **or** a live `kubectl patch` /
     `kubectl set resources` on the `ws-slot42` workloads. Record the exact final numbers in
     the results JSON (`meta.resources`).
2. **Same reduction for every store.** Fleet freshness = `now − MIN(per-site MAX(ts_ms))`
   over **frac sites only** (`site_id LIKE 'ws-slot42-frac-%'`). This is the mask-proof
   "stalest actively-reporting frac site" already implemented in
   `cloud-dashboard/src/lib/freshness-queries.ts` (`toPayload` uses `Math.min`). The harness
   (§5) must apply the **identical** `WHERE` and reduction to RW, TSDB-raw, TSDB-CAGG, and
   InfluxDB.
3. **Same run, same rungs, interleaved sampling.** All stores sampled within the same rung
   window, back-to-back, so they see the same ingest state.
4. **Clock-skew bound.** `ts_ms` (producer pod), Kafka broker time, `connect_recv_ts`
   (committer pod), and `db_insert_ts`/`now()` (DB) are on **different clocks**. EKS nodes are
   NTP-synced; a prior check bounded producer-vs-DB skew to sub-100 ms. **Re-verify at run
   time** (§5 step 0) and record it. Same-clock deltas (DB insert → DB query) are exact;
   cross-clock deltas carry ±skew and must be labelled as such in the blog.

---

## 4. Infrastructure changes required (for per-hop instrumentation, Q6)

All three are additive and safe to apply to the live `ws-slot42` stack. Apply in this order.

### 4a. Add a DB-side insert timestamp column

`sensor_readings` currently has no server-side landing time. Add one stamped by the DB clock:

```sql
-- run against timescaledb-cloud-1 / db edge
ALTER TABLE sensor_readings
  ADD COLUMN IF NOT EXISTS db_insert_ts TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp();
```
- `clock_timestamp()` (not `now()`) — `now()` is transaction-start time; `clock_timestamp()`
  is the actual wall-clock at row insert, which is what we want for the insert hop.
- Chart source to update to match (so a redeploy keeps it):
  `helm/cloud-analytics/templates/timescaledb-cluster.yaml`, the
  `CREATE TABLE IF NOT EXISTS sensor_readings (...)` block (add the column), and the CAGG in
  `helm/cloud-analytics/templates/timescaledb-notify-ddl-job.yaml` if you want a
  `max(db_insert_ts)` in the aggregate.

### 4b. Stamp broker + committer receive time in the committer

Edit `helm/cloud-analytics/templates/rp-connect-timescaledb-config.yaml` **and** the live
configmap `rp-connect-timescaledb-config` in `ws-slot42`. In the final `mapping` processor
(the one that sets `partition_time`, currently ~line 80–91), add two fields:

```coffee
root = this
# Broker-assigned Kafka timestamp (ms since epoch) — the message's arrival at MSK.
root.broker_ts_ms = metadata("kafka_timestamp").number()          # kafka_franz sets this
# Committer receive time (ms) — this pod's clock as the batch is processed.
root.connect_recv_ts_ms = (now().ts_unix_nano() / 1000000).floor()
# ... existing partition_time line stays ...
root.partition_time = ((this.ts_ms / 10000).floor() * 10).ts_unix().format_timestamp("2006-01-02T15:04:05Z07:00")
```

Then widen the sink `INSERT` (same file, `output.sql_raw.query`) to carry the two new fields
and let `db_insert_ts` default:

```sql
INSERT INTO sensor_readings
  (sensor, site_id, deployment_id, value, unit, ts_ms, partition_time, broker_ts_ms, connect_recv_ts_ms)
SELECT sensor, site_id, deployment_id, value, unit, ts_ms, partition_time, broker_ts_ms, connect_recv_ts_ms
FROM jsonb_to_recordset($1::jsonb) AS x(
  sensor text, site_id text, deployment_id text,
  value double precision, unit text, ts_ms bigint, partition_time timestamptz,
  broker_ts_ms bigint, connect_recv_ts_ms bigint
)
```
And `ALTER TABLE sensor_readings ADD COLUMN IF NOT EXISTS broker_ts_ms BIGINT, ADD COLUMN IF NOT EXISTS connect_recv_ts_ms BIGINT;`

Roll the committer: `kubectl rollout restart deploy/cloud-analytics-redpanda-connect -n ws-slot42`.
(Recall `maxSurge=0` is patched on this deployment; it recreates in place — expect a brief
ingest pause.) Confirm new rows carry the columns:
```sql
SELECT ts_ms, broker_ts_ms, connect_recv_ts_ms,
       extract(epoch from db_insert_ts)*1000 AS db_insert_ms
FROM sensor_readings
WHERE deployment_id='ws-slot42' AND partition_time > now()-interval '30 seconds'
ORDER BY db_insert_ts DESC LIMIT 5;
```

### 4c. (Optional) RisingWave per-hop

RisingWave already computes a device→ingest hop (`mv_device_hop_latency`,
`risingwave/ddl-cloud.sql`). For the frac path, the meaningful RW hop is
**produce → MV-visible**. Measure it in the harness as `now − MAX(ts_ms)` on
`mv_sensor_fleet_latest` (that *is* the MV-visibility lag, dominated by the barrier interval,
`values.yaml: risingwave.barrierIntervalMs: 500`). No DDL change strictly required.

---

## 5. The measurement harness

Start from the committed, parameterized harness at
[`docs/experiments/harness/measure-freshness.py`](harness/measure-freshness.py) (`--slot` /
`--namespace` / `--pg-pod` / `--rungs`). As committed it measures the **TimescaleDB**
freshness/CAGG path only — the `Harness.sample()` method carries an `EXTEND HERE` marker for
adding the RisingWave MV, InfluxDB, and Q4 aggregation reads so all four stores are sampled in
the **same window**. The load-pod runner is
[`docs/experiments/harness/frac-runner.py`](harness/frac-runner.py); see
[`harness/README.md`](harness/README.md) for the `kubectl cp` deploy + run steps.

The completed harness must, **per rung, for every store, in the same window**, capture:

- **Freshness** — `now − MIN(per-site MAX(ts_ms))` over frac sites (stalest frac site).
- **Latest-value query latency** — wall time of the "latest per site" read.
- **Aggregation query latency + result** — the §6 Q4 analytical query (latency *and* the
  returned value, so you can confirm all stores agree → correctness check).
- **Per-hop decomposition** (TSDB only, from §4 columns) — see §5.2.

### 5.0 Step 0 — clock-skew check (record, don't skip)

Bound each pod clock against a common reference (the machine running the harness) with
pre/post local timestamps; a remote clock landing inside its round-trip window ⇒ no gross
skew. Sample `timescaledb-cloud-1`, one `frac-load-big*`, and a `redpanda-connect` pod.
Record the offsets in `meta.clock_skew_ms`. (Reference implementation: the `skew()` bash
function used previously — reproduce it or port to Python.)

### 5.1 Rungs

Drive the generator (`/tmp/frac-runner.py` in each load pod, deployed from
`docs/experiments/harness/`) with
`--slot ws-slot42 --sites 20 --units-per-site 2 --hz <H> --duration <D>`. Offered rate =
`n_pods × 40 engines × n_sensors × H`. **Read the achieved rate from each generator's
`[load] SUMMARY` line — do not trust the nominal target.** Prior runs used:

| Rung (offered) | pods | approx hz/pod | notes |
|---|---|---|---|
| ~114/s | 1 | ~0.57 | low-cadence rung — expect freshness ≈ emit interval |
| ~9,000/s | 1 | ~45 | single-producer ceiling is ~9k (GIL/serialization) |
| ~13,000/s | 1 | ~36* | *if n_sensors≈9; tune to hit target |
| ~27,000/s | 2 | ~37 | |
| ~35,000/s | 3 | ~37 | |
| ~63,000/s | 6 | ~31 | peak — 6 producers across pods |

Per rung: `WARMUP≈70 s`, `SAMPLE_WINDOW≈75 s`, sample every 5 s (≥10 samples/rung), then
report median/min/max/p95 per metric. Total ≈ 3 min/rung × 6 rungs × (setup) ≈ 25–35 min.

### 5.2 Per-hop SQL (TSDB, after §4 lands)

All hops read the **freshest frac row** each store already ingested. Combined cross-clock
hop + exact same-clock hop:

```sql
SET statement_timeout='25s';
WITH recent AS (
  SELECT ts_ms, broker_ts_ms, connect_recv_ts_ms,
         extract(epoch from db_insert_ts)*1000 AS db_insert_ms
  FROM sensor_readings
  WHERE deployment_id='ws-slot42'
    AND site_id LIKE 'ws-slot42-frac-%'
    AND partition_time > now() - interval '30 seconds'
  ORDER BY db_insert_ts DESC
  LIMIT 20000                         -- newest window; keep it chunk-excluded
)
SELECT
  round(avg(broker_ts_ms      - ts_ms))              AS h1_generate_to_broker_ms,   -- x-clock (producer→broker)
  round(avg(connect_recv_ts_ms- broker_ts_ms))       AS h2_broker_to_committer_ms,  -- x-clock (broker→committer)
  round(avg(db_insert_ms      - connect_recv_ts_ms)) AS h3_committer_to_insert_ms,  -- x-clock (committer→DB); batch wait + INSERT
  round(extract(epoch from now())*1000 - max(db_insert_ms)) AS h4_insert_to_query_ms -- SAME clock (DB→DB); EXACT
FROM recent;
```
- **H4 is exact** (DB clock on both sides): "how long the freshest landed row waited before
  the read saw it" ≈ bounded by how often you query (poll interval). In the live dashboard
  this is the SSE/poll cadence.
- **H1+H2+H3 = produce→landed**, cross-clock (producer vs DB); trust to ±(measured skew).
  Report the *sum* (produce→landed) as the robust number and the sub-hops as
  "indicative, ±clock-skew."
- **End-to-end = now − MAX(ts_ms)** = the freshness number, and should ≈ (H1+H2+H3+H4).

### 5.3 Output JSON schema

```jsonc
{
  "meta": {
    "run_utc": "...", "slot": "ws-slot42", "branch": "...",
    "resources": { "risingwave": {...}, "timescaledb": {...}, "influxdb": {...}, "committer": {...} },
    "clock_skew_ms": { "timescaledb": 0, "frac_load_big": 0, "redpanda_connect": 0 }
  },
  "rungs": [
    {
      "rung": "~63,000/s", "pods": 6, "hz": 31, "achieved_rate_msg_s": 60480,
      "freshness_ms":     { "risingwave": {...}, "tsdb_raw": {...}, "tsdb_cagg": {...}, "influxdb": {...} },
      "latest_latency_ms":{ "risingwave": {...}, "tsdb_raw": {...}, "tsdb_cagg": {...}, "influxdb": {...} },
      "agg_latency_ms":   { "risingwave": {...}, "tsdb_raw": {...}, "tsdb_cagg": {...}, "influxdb": {...} },
      "agg_result":       { "risingwave": 71.2, "tsdb_raw": 71.2, "tsdb_cagg": 71.2, "influxdb": 71.1 },
      "per_hop_ms":       { "h1_generate_to_broker": 8, "h2_broker_to_committer": 12, "h3_committer_to_insert": 41, "h4_insert_to_query": 9 }
    }
  ]
}
```
Each `{...}` is `{ "n":, "median":, "min":, "max":, "p95": }`.

---

## 6. The queries (identical semantics across stores)

### Latest-value freshness (the "clock signal") — per store

```sql
-- TSDB raw
WITH per AS (SELECT site_id, MAX(ts_ms) m FROM sensor_readings
             WHERE deployment_id='ws-slot42' AND site_id LIKE 'ws-slot42-frac-%'
               AND partition_time > now()-interval '2 minutes' GROUP BY site_id)
SELECT round(extract(epoch from now())*1000 - MIN(m)) FROM per;   -- stalest frac site

-- TSDB CAGG (materialized_only=false real-time read)
WITH per AS (SELECT site_id, MAX(max_ts_ms) m FROM sensor_readings_cagg
             WHERE deployment_id='ws-slot42' AND site_id LIKE 'ws-slot42-frac-%'
               AND bucket > now()-interval '2 minutes' GROUP BY site_id)
SELECT round(extract(epoch from now())*1000 - MIN(m)) FROM per;

-- RisingWave MV
WITH per AS (SELECT site_id, MAX(ts_ms) m FROM mv_sensor_fleet_latest
             WHERE deployment_id='ws-slot42' AND site_id LIKE 'ws-slot42-frac-%' GROUP BY site_id)
SELECT round(extract(epoch from now())*1000 - MIN(m)) FROM per;
```
(InfluxDB: query the rollup measurement's latest per-site point; freshness = now − min over sites.)

### Q4 — the analytical aggregation (the real read-engine test)

**Semantics (identical for all stores):** *mean free-CPU across all frac sites over the last
1 minute.* Free-CPU = `100 − cpu_pct`.

```sql
-- TSDB raw: scans the 1-min window (~n_sensors×40×rate rows) — the expensive path
SELECT avg(100.0 - value)
FROM sensor_readings
WHERE deployment_id='ws-slot42' AND site_id LIKE 'ws-slot42-frac-%'
  AND sensor='cpu_pct' AND partition_time > now()-interval '1 minute';

-- TSDB CAGG: recombine bucket sums over the window (few hundred bucket rows)
SELECT sum(sum_value) FILTER (WHERE sensor='cpu_pct')
       / NULLIF(sum(n) FILTER (WHERE sensor='cpu_pct'),0)
  AS avg_cpu
FROM sensor_readings_cagg
WHERE deployment_id='ws-slot42' AND site_id LIKE 'ws-slot42-frac-%'
  AND bucket > now()-interval '1 minute';   -- report 100 - avg_cpu

-- RisingWave: use mv_fleet_1min_avg (TUMBLE 1-min) if it carries cpu_pct free-CPU;
-- otherwise compute over mv_sensor_fleet_latest for the current-fleet variant and
-- LABEL it as "current fleet" not "1-min window" (keep semantics honest per store).
```
- Record **both latency and returned value** per store. The values should agree to within
  rounding — that's the correctness check that proves the queries are equivalent. If they
  don't agree, the comparison is still broken; stop and reconcile before trusting latencies.
- **Expectation to test (Q4 hypothesis):** RW/CAGG answer this cheaply (pre-aggregated);
  TSDB-raw latency climbs with load (scans a bigger window). This is where RW's architecture
  should finally show its advantage — if it doesn't, that itself is a finding.

---

## 7. What "makes sense" looks like (interpretation guide)

- **Freshness low-rung anomaly resolved:** report freshness **split into emit-cadence vs
  pipeline-lag**. At 114/s all stores should show ~1.75 s *because of cadence*; the
  pipeline-lag component (H2+H3+H4, or produce→queryable minus the emit interval) should be
  small at every rung. Don't present raw `now−MAX(ts_ms)` at 114/s next to 63k/s without this
  decomposition.
- **RW vs TSDB freshness:** expect TSDB-raw ≤ RW-MV on *latest-value freshness*, because a
  committed INSERT is visible immediately while the MV waits for a barrier (~500 ms, more
  under compute pressure). This is a real, explainable result — **not** "TSDB is faster than
  RW." State the mechanism.
- **Query latency:** expect the ordering to **flip** on the Q4 aggregation vs the latest-value
  read. If TSDB-raw aggregation latency climbs with load and RW stays flat, that's the honest
  RW-wins-on-analytics story.
- **Per-hop:** H3 (committer→insert, batch wait + bulk INSERT) should dominate produce→landed;
  H4 (insert→query) should be ~poll-interval-bounded. If H3 balloons at 63k, that's the store
  keeping up or not.

---

## 8. Visualization (for the blog)

Produce two figures from the results JSON with a standalone matplotlib script
(portable — no cluster access needed once JSON exists):

1. **Per-hop waterfall / stacked bar**, one horizontal bar per rung, segments =
   `generate→broker`, `broker→committer`, `committer→insert`, `insert→query`. Annotate
   cross-clock segments with "±skew." Title: "Where the freshness time goes (TimescaleDB)."
2. **Grouped comparison across rungs** — three small-multiples (freshness, latest-value
   latency, Q4 aggregation latency), each with a line per store (RW, TSDB-raw, TSDB-CAGG,
   InfluxDB) vs offered rate. This replaces the two hand-built tables.

Also re-capture the live dashboard with `e2e/screenshot-dashboard.mjs --slot ws-slot42`
(freshness is a sawtooth — sample repeatedly, see CLAUDE.md), and add the new per-hop panel to
the dashboard if you extend it.

---

## 9. Blog rewrite plan (`docs/blog/2026-09-09-loading-the-data-stores.md`)

Replace, using the new JSON as the single source of truth:

- **Freshness table (~L529):** all four columns from the *same* run, same reduction. Add the
  emit-cadence-vs-lag split (either two sub-columns or a footnote with the decomposition).
- **Query-latency table (~L391):** label the exact query path per store; add the **Q4
  aggregation-latency** table (the new headline comparison). Remove the internally
  inconsistent "includes ~40 ms overhead" claim or make it consistent with the measured
  values.
- **Resource-parity claim (~L300):** replace "all sized to 4 vCPU / 32 GiB" with the real
  equalized numbers from §3 and the committer-asymmetry disclosure.
- **Footnotes ⁂ / † / ‡:** rewrite ⁂ to define freshness with the cadence caveat; keep the
  produce-to-queryable (not device-to-store) scope disclosure (the frac generator produces
  **straight to MSK** — `simulator/frac-msk-load.py`, `producer.send('sensors.raw.sim', …)`,
  `ts_ms` stamped at `simulator/sensor-sim.py:149` immediately before send — so "end-to-end"
  = **store ingest tail**, *excluding* the device→MQTT→IoT-Core→Rule→landing ingress).
- **New section:** "Where the latency goes — per-hop" with the waterfall figure (Q6).
- **New section / expand:** the Q4 analytical-aggregation comparison (this is where RW's
  design pays off).
- **Summary points (L689/L780/L817 area):** reconcile to the new data.

---

## 10. Open decisions to confirm with the blog author before running

1. **Resource target for equalization** (§3): proposal is a common **2 CPU / 8 GiB** limit on
   RW-compute, TSDB, and InfluxDB, committer counted against TSDB. Confirm the numbers.
2. **How to treat the committer** in the write-up: subtract from TSDB's budget, or disclose as
   asymmetry. (Recommend: disclose + also report a "committer CPU counted" line.)
3. **Q4 semantics for RisingWave:** true 1-min TUMBLE window (needs `mv_fleet_1min_avg` to
   carry free-CPU) vs "current fleet" over `mv_sensor_fleet_latest`. Pick one and keep all
   stores on the *same* semantics, or clearly label per-store differences.
4. **InfluxDB:** keep it in the head-to-head (it's resource-starved and off a different read
   model) or move it to a clearly-labelled "different tool, context only" callout.

---

## 11. Cleanup / teardown

- Stop load: the generators self-terminate at `--duration`; to be safe,
  `kubectl -n ws-slot42 exec <pod> -- pkill -f frac-runner` on each load pod.
- The bare `frac-load-big*` pods can be left (idle, but hold CPU requests) or deleted:
  `kubectl delete pod -n ws-slot42 frac-load-big{,2,3,4,5,6}`.
- The §4 schema/committer changes are **intended to persist** (they're the instrumentation).
  Fold them into the chart (`timescaledb-cluster.yaml`, `rp-connect-timescaledb-config.yaml`,
  `timescaledb-notify-ddl-job.yaml`) so a future `deploy-cloud-analytics.sh` keeps them.
- If you equalized resources via live `kubectl patch`, mirror the final values into
  `values.yaml` so the chart matches reality.

---

## 12. Acceptance criteria (this experiment is "done" when)

- [ ] One results JSON with all four stores measured in the **same run**, same reduction,
      recorded resources, and recorded clock-skew.
- [ ] Freshness reported with the emit-cadence-vs-pipeline-lag split (Q1 resolved).
- [ ] RW vs TSDB freshness difference explained by barrier-vs-commit visibility, from the same
      run (Q2 resolved).
- [ ] Query-latency reported with the exact per-store query path labelled, and the Q4
      aggregation comparison added (Q3 + Q4 resolved).
- [ ] Resources equalized (or asymmetry explicitly disclosed) and the "4 vCPU / 32 GiB" claim
      corrected (Q5 resolved).
- [ ] Per-hop waterfall figure generated and in the blog (Q6 resolved).
- [ ] Blog tables/sections replaced from the JSON; no mixed-provenance numbers remain.
