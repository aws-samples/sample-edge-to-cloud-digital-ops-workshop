# Block 6 — Live Analytics Dashboard

**Duration:** 30 min

---

## What You've Been Looking At

If you opened the dashboard at the start of this section (Block 1), you've already seen it: four live charts comparing the same telemetry as served by RisingWave, TimescaleDB, Timestream for InfluxDB, and Athena/Iceberg side by side.

| Chart | Y axis | Source |
|---|---|---|
| **Data Freshness** | Milliseconds — **log scale** | All four tiers |
| **Fleet Free CPU & Memory** | Percent free (higher = healthier) | Both self-managed live DBs |
| **Time Since Last Message** | Seconds per node | Both self-managed live DBs |

All four stores serve the same telemetry, so you can directly compare how stale each store's view of the fleet is — a live streaming MV (RisingWave), a live relational scan (TimescaleDB), a **managed** time-series store polled on demand (Timestream for InfluxDB — [Block 5](block-5-timestream-influxdb.md)), and an on-demand warehouse query (Athena over the Iceberg table in S3). This block explains how each chart gets its data.

If you don't already have it open:

```bash
kubectl port-forward -n ws-slot00 svc/cloud-analytics-dashboard 3000:3000 > /tmp/dashboard-pf.log 2>&1 &
DASH_PF_PID=$!
until grep -q "Forwarding from" /tmp/dashboard-pf.log 2>/dev/null; do sleep 1; done
curl -sf http://localhost:3000 | head -c 200
kill "$DASH_PF_PID" 2>/dev/null || true
```
<!-- e2e:assert {"contains": "<"} -->

Or keep the port-forward running in a separate terminal and open `http://localhost:3000` in a browser. The RisingWave and TimescaleDB indicators show `live · push`; InfluxDB and Athena show `live · poll`. If any tier shows `(mock)`, the dashboard's endpoint env vars aren't wired to a live store yet — see [Connecting to Live Databases](#connecting-to-live-databases) below.

---

## Chart 1 — Data Freshness (log scale)

The Y axis uses a **log₁₀ scale** because the four tiers span four orders of magnitude:

| Tier | Typical freshness |
|---|---|
| RisingWave MV | 100 ms – 1 s (sawtooth — steps with each checkpoint barrier) |
| TimescaleDB (windowed scan) | 100–600 ms |
| Timestream for InfluxDB (polled) | ~1–2 s (Telegraf flush + poll cadence) |
| Athena/S3 | tens of s up to ~300 s |

A linear axis would make RisingWave, TimescaleDB, and InfluxDB indistinguishable — the log scale makes all four tiers clearly visible at once.

!!! tip "Freshness vs. query latency — read [Data Store Performance Characteristics](#data-store-performance-characteristics) below"
    RisingWave and TimescaleDB land in the same freshness band, but for very
    different reasons, and their **read latency** and **scaling behaviour** diverge
    sharply as the fleet grows. If the newest row is *ever* seconds-to-minutes
    stale in a live tier, that's an **ingestion/freshness** signal — not the read
    path being slow. It has two distinct causes: an *upstream* pause (a
    stopped/redeploying simulator, MSK consumer-lag spike) that starves **every**
    tier at once, or a *per-store* pipeline problem that lags **one** tier while
    the others stay fresh — e.g. RisingWave's checkpoint-commit path falling behind
    (see the worked example at the end of this section). The performance section
    spells out which store to reach for under a fixed latency budget, and how to
    tell the two failure modes apart.

??? example "Query — RisingWave and TimescaleDB freshness"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/cloud-dashboard/src/lib/freshness-queries.ts){ .md-button target=_blank }

    ```typescript
    --8<-- "cloud-dashboard/src/lib/freshness-queries.ts"
    ```

    Freshness = `Date.now() - MAX(ts_ms)`. Both tiers use `ts_ms`/the equivalent column populated from `ingest_ts` — the epoch-ms timestamp stamped by IoT Core when the message arrived, not the device clock — so clock-skew between EC2 edge nodes and the dashboard is eliminated.

??? example "Query — Athena / Iceberg"
    ```sql
    SELECT
      thing_name AS site_id,
      MAX(message_timestamp) AS latest_ts_ms,
      AVG(100.0 - CAST(cpu_pct AS double))      AS avg_free_cpu_pct,
      AVG(100.0 - CAST(mem_used_pct AS double)) AS avg_free_mem_pct
    FROM workshop_telemetry.telemetry
    GROUP BY thing_name
    ```
    Same `Date.now() - MAX(...)` freshness formula, run against the Iceberg
    table in S3 via Athena. `message_timestamp` is the same epoch-ms basis as
    `ts_ms` in the other tiers, so the three numbers are apples-to-apples. The
    route submits the query, polls `GetQueryExecution` until it succeeds (cap
    30 s), and reads the result — which is why this tier reports tens of seconds
    of "freshness" even when the data itself is recent: you're measuring the
    warehouse round-trip, not a live push.

### CLI — read the same numbers

The panels above render in a browser, but the underlying numbers are just SQL —
you can read them from the CLI with the exact same queries the dashboard runs.
Each block below prints a one-line JSON
`{"tier", "freshness_ms", "query_latency_ms", "rows"}` capturing **two distinct
metrics** for that tier:

| Metric | What it is | Governed by |
|---|---|---|
| `freshness_ms` | `now − MAX(timestamp)` — how stale the newest row is | the **ingestion** pipeline (arrival lag) |
| `query_latency_ms` | wall-clock to execute the read query | the **read path** (in-memory MV vs relational scan vs warehouse round-trip) |

They're orthogonal: a store can hold second-old data (fresh) yet answer slowly,
or hold stale data yet answer instantly. Freshness is computed **in-SQL**
(`now()` in epoch-ms minus the store's latest timestamp) so there's no dependency
on the client clock or a GNU-only `date` flag; query latency is measured around
the query call itself.

The end-to-end suite runs these blocks against a live slot and records each
tier's `freshness_ms` **and** `query_latency_ms` in the run report's
**Data freshness & query latency** table, so both ladders are captured on every
e2e pass — the CLI equivalent of the dashboard's freshness and query-latency
charts.

!!! warning "Measurement trap (#206): never ask RisingWave for its own `now()`"
    It's tempting to compute freshness entirely in-SQL — `now() - MAX(ts_ms)` — the
    way the TimescaleDB and Athena blocks below do. **Don't do this for
    RisingWave.** RW's SQL `now()` tracks its last *committed* checkpoint epoch,
    not wall-clock. If the checkpoint-commit path lags (the CPU-starvation failure
    mode [#211](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/issues/211)
    fixes), `now()` lags by the *same* amount — so `now() - MAX(ts_ms)`
    computed **inside** RisingWave cancels the lag out and reports sub-second
    freshness while the underlying data is minutes old. Worse, if `now()` ever lags
    *behind* the most recent committed row's `ts_ms` (e.g. right after a barrier
    catches back up), the subtraction goes **negative** — an unmistakable tell that
    something is measuring against the wrong clock. The block below deliberately
    timestamps with the CLI's own wall-clock (a portable epoch-ms helper —
    `python3 -c 'import time; print(int(time.time()*1000))'`, which behaves
    identically on GNU/Linux and BSD/macOS, unlike a millisecond-precision
    `date` flag) instead of RW's `now()`, for the same reason the dashboard's
    routes use `Date.now()` (see the note under
    [Chart 1](#chart-1-data-freshness-log-scale) for the full story).

!!! note "Why the CLI blocks below use a warm `psql \timing` reading for query latency"
    Wrapping the whole `psql` invocation between two wall-clock reads — the way
    `time psql ...` or the naive `$(epoch_ms)` … `$(epoch_ms)` pattern would —
    bundles process spawn, TCP connect, and the `kubectl port-forward` tunnel's
    own round-trip in with the query itself. On a live slot that's ~1 s of setup
    dwarfing the actual read, and it makes RisingWave's in-memory MV lookup look
    as slow as a warehouse scan
    ([#239](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/issues/239)).
    The RisingWave and TimescaleDB blocks below instead open **one** `psql`
    session with `\timing on`, run the read query once as a discarded warm-up,
    run it again, and parse the **second** (warm) `Time: <n> ms` line —
    `\timing` reports only server-side execution plus one round-trip on an
    already-open connection, the same thing the live dashboard's
    `/api/stream/*` routes measure by timing `pool.query(...)` alone, inside the
    pod. Treat this CLI reading as a sanity check: the dashboard's **Query
    latency** chart, driven by that same server-side timing, is the canonical
    number.

??? example "RisingWave — freshness + query latency (port 4567)"
    ```bash
    kubectl port-forward -n ws-slot00 svc/risingwave-cloud-frontend 4567:4567 > /tmp/rw-fresh-pf.log 2>&1 &
    RW_PF_PID=$!
    until grep -q "Forwarding from" /tmp/rw-fresh-pf.log 2>/dev/null; do sleep 1; done
    # Same MV the dashboard's /api/stream/risingwave route reads. ts_ms is the
    # IoT-Core ingest timestamp (epoch-ms), so freshness is clock-skew-free.
    # Timestamp with the CLIENT's wall-clock, not RisingWave's own now() — see
    # the measurement-trap warning above. One session, \timing on, a discarded
    # warm-up SELECT then the measured SELECT — this isolates engine read
    # latency from psql-spawn + connect/auth + tunnel cost (see the note above).
    epoch_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
    RW_RAW=$(psql -h localhost -p 4567 -U root -d dev -tA -F'|' <<'SQL'
    \timing on
    SELECT MAX(ts_ms), COUNT(*) FROM mv_sensor_fleet_latest;
    SELECT MAX(ts_ms), COUNT(*) FROM mv_sensor_fleet_latest;
    SQL
    )
    RW_NOW=$(epoch_ms)
    IFS='|' read -r RW_MAX_TS RW_ROWS < <(echo "$RW_RAW" | grep -v '^Time:' | tail -1)
    RW_LAT=$(echo "$RW_RAW" | grep '^Time:' | tail -1 | awk '{print $2}')
    RW_LAT=$(printf '%.0f' "${RW_LAT:-0}")
    RW_FRESH=""
    [ -n "$RW_MAX_TS" ] && RW_FRESH=$(( RW_NOW - RW_MAX_TS ))
    kill "$RW_PF_PID" 2>/dev/null || true
    echo "{\"tier\":\"risingwave\",\"freshness_ms\":${RW_FRESH:-null},\"query_latency_ms\":${RW_LAT},\"rows\":${RW_ROWS:-0}}"
    ```
    <!-- e2e:assert {"captureFreshness": true} -->

??? example "TimescaleDB — freshness + query latency (port 5432)"
    ```bash
    TSDB_PASS=$(kubectl get secret timescaledb-cloud-app -n ws-slot00 \
      -o jsonpath='{.data.password}' | base64 -d)
    kubectl port-forward -n ws-slot00 svc/timescaledb-cloud-rw 5432:5432 > /tmp/tsdb-fresh-pf.log 2>&1 &
    TSDB_PF_PID=$!
    until grep -q "Forwarding from" /tmp/tsdb-fresh-pf.log 2>/dev/null; do sleep 1; done
    # Same sensor_readings table the dashboard's /api/stream/timescaledb route reads.
    # The `partition_time > now() - interval '15 minutes'` predicate is load-bearing:
    # it lets TimescaleDB do chunk exclusion (skip every chunk older than the window)
    # instead of scanning the whole raw hypertable on every read. Without it this
    # aggregates all history and grows unbounded — tens of seconds once the table
    # hits millions of rows. One session, \timing on, a discarded warm-up SELECT
    # then the measured SELECT — same isolation as the RisingWave block above;
    # freshness still comes from the (warm) query's own now() - MAX(ts_ms).
    TS_RAW=$(PGPASSWORD="$TSDB_PASS" psql -h localhost -p 5432 -U workshop -d edge -tA -F'|' <<'SQL'
    \timing on
    SELECT (EXTRACT(EPOCH FROM now())*1000)::bigint - MAX(ts_ms), COUNT(*) FROM sensor_readings WHERE partition_time > now() - interval '15 minutes';
    SELECT (EXTRACT(EPOCH FROM now())*1000)::bigint - MAX(ts_ms), COUNT(*) FROM sensor_readings WHERE partition_time > now() - interval '15 minutes';
    SQL
    )
    IFS='|' read -r TS_FRESH TS_ROWS < <(echo "$TS_RAW" | grep -v '^Time:' | tail -1)
    TS_LAT=$(echo "$TS_RAW" | grep '^Time:' | tail -1 | awk '{print $2}')
    TS_LAT=$(printf '%.0f' "${TS_LAT:-0}")
    kill "$TSDB_PF_PID" 2>/dev/null || true
    echo "{\"tier\":\"timescaledb\",\"freshness_ms\":${TS_FRESH:-null},\"query_latency_ms\":${TS_LAT},\"rows\":${TS_ROWS:-0}}"
    ```
    <!-- e2e:assert {"captureFreshness": true} -->

??? example "Athena / Iceberg — freshness + query latency (no port-forward)"
    ```bash
    # Same Iceberg table + message_timestamp basis the dashboard's
    # /api/freshness?tier=athena route queries. Both freshness AND query latency
    # here include the warehouse round-trip, so both are tens of seconds even
    # when the underlying data is recent. Time the full submit→poll→fetch cycle.
    epoch_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
    AT_T0=$(epoch_ms)
    QUERY_ID=$(aws athena start-query-execution \
      --work-group workshop-shared \
      --query-string "SELECT CAST(to_unixtime(now())*1000 AS bigint) - MAX(message_timestamp) AS freshness_ms, COUNT(*) AS n FROM workshop_telemetry.telemetry WHERE deployment_id='ws-slot00'" \
      --query QueryExecutionId --output text)

    for _i in $(seq 1 20); do
      STATE=$(aws athena get-query-execution \
        --query-execution-id "$QUERY_ID" \
        --query 'QueryExecution.Status.State' --output text)
      if [ "$STATE" = "SUCCEEDED" ] || [ "$STATE" = "FAILED" ] || [ "$STATE" = "CANCELLED" ]; then
        break
      fi
      sleep 3
    done

    AT_FRESH=$(aws athena get-query-results --query-execution-id "$QUERY_ID" \
      --query 'ResultSet.Rows[1].Data[0].VarCharValue' --output text)
    AT_ROWS=$(aws athena get-query-results --query-execution-id "$QUERY_ID" \
      --query 'ResultSet.Rows[1].Data[1].VarCharValue' --output text)
    AT_LAT=$(( $(epoch_ms) - AT_T0 ))
    # aws CLI renders a SQL NULL as the literal "None" in text output — normalise it.
    if [ "$AT_FRESH" = "None" ]; then AT_FRESH=""; fi
    if [ "$AT_ROWS" = "None" ]; then AT_ROWS=""; fi
    echo "{\"tier\":\"athena\",\"freshness_ms\":${AT_FRESH:-null},\"query_latency_ms\":${AT_LAT},\"rows\":${AT_ROWS:-0}}"
    ```
    <!-- e2e:assert {"captureFreshness": true} -->

??? example "Timestream for InfluxDB — freshness + query latency (port 8086)"
    ```bash
    # Same per-slot bucket + sensor_reading schema the dashboard's
    # /api/freshness?tier=influxdb route queries (see Block 5). The url/token/org/
    # bucket live in the influxdb-credentials secret the in-cluster provision Job
    # mints; read them, port-forward to the managed instance, and run one Flux
    # query for the newest point's timestamp. Freshness is subtracted against the
    # CLIENT wall-clock (a portable epoch-ms helper) — same discipline as the
    # other tiers.
    epoch_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
    IX_URL=$(kubectl get secret influxdb-credentials -n ws-slot00 -o jsonpath='{.data.INFLUX_URL}' | base64 -d)
    IX_TOKEN=$(kubectl get secret influxdb-credentials -n ws-slot00 -o jsonpath='{.data.INFLUX_TOKEN}' | base64 -d)
    IX_ORG=$(kubectl get secret influxdb-credentials -n ws-slot00 -o jsonpath='{.data.INFLUX_ORG}' | base64 -d)
    IX_BUCKET=$(kubectl get secret influxdb-credentials -n ws-slot00 -o jsonpath='{.data.INFLUX_BUCKET}' | base64 -d)
    IX_HOSTPORT=$(echo "$IX_URL" | sed -E 's#^https?://##')
    IX_HOST=${IX_HOSTPORT%%:*}
    # Tunnel to the VPC-private instance through any pod with network access.
    kubectl run influx-tunnel-$$ -n ws-slot00 --image=alpine/socat --restart=Never --command -- \
      socat TCP-LISTEN:8086,fork,reuseaddr "TCP:${IX_HOST}:8086" >/dev/null 2>&1 || true
    kubectl wait --for=condition=Ready pod/influx-tunnel-$$ -n ws-slot00 --timeout=60s >/dev/null 2>&1 || true
    kubectl port-forward -n ws-slot00 pod/influx-tunnel-$$ 8086:8086 > /tmp/ix-fresh-pf.log 2>&1 &
    IX_PF_PID=$!
    until grep -q "Forwarding from" /tmp/ix-fresh-pf.log 2>/dev/null; do sleep 1; done
    # Newest point across the bucket, as epoch-ms. Flux `last()` after a wide
    # range gives the most-recent sensor_reading; _time is RFC3339 → epoch-ms.
    FLUX='from(bucket:"'"$IX_BUCKET"'") |> range(start:-15m) |> filter(fn:(r)=> r._measurement=="sensor_reading" and r._field=="value") |> last() |> keep(columns:["_time"]) |> max(column:"_time")'
    IX_T0=$(epoch_ms)
    IX_TIME=$(curl -sf -k "https://localhost:8086/api/v2/query?org=${IX_ORG}" \
      -H "Authorization: Token ${IX_TOKEN}" \
      -H 'Accept: application/csv' \
      -H 'Content-Type: application/vnd.flux' \
      -d "$FLUX" | awk -F, 'NR>1 && $NF ~ /T/ {print $NF; exit}')
    IX_NOW=$(epoch_ms)
    IX_LAT=$(( IX_NOW - IX_T0 ))
    IX_FRESH=""
    if [ -n "$IX_TIME" ]; then
      # Portable RFC3339 -> epoch-ms parse (no GNU-only date-parsing flag).
      # Pads/truncates the fractional-seconds component to exactly 6 digits so
      # fromisoformat accepts InfluxDB's nanosecond-precision _time on any
      # Python 3.7+.
      IX_TS=$(python3 -c '
import datetime, re, sys
s = sys.argv[1].strip().replace("Z", "+00:00")
s = re.sub(r"\.(\d+)", lambda m: "." + (m.group(1) + "000000")[:6], s)
print(int(datetime.datetime.fromisoformat(s).timestamp() * 1000))
' "$IX_TIME" 2>/dev/null)
      [ -n "$IX_TS" ] && IX_FRESH=$(( IX_NOW - IX_TS ))
    fi
    kill "$IX_PF_PID" 2>/dev/null || true
    kubectl delete pod influx-tunnel-$$ -n ws-slot00 --wait=false >/dev/null 2>&1 || true
    echo "{\"tier\":\"influxdb\",\"freshness_ms\":${IX_FRESH:-null},\"query_latency_ms\":${IX_LAT},\"rows\":null}"
    ```
    <!-- e2e:assert {"captureFreshness": true} -->

---

## Data Store Performance Characteristics

The freshness and query-latency charts show a snapshot at the workshop's 3-device
scale. The question that matters in production is different: **can each store keep
answering within a fixed time budget as the fleet grows?** The customer driving
this workshop has a hard **2-second end-to-end budget** — from "a value lands in
the store" to "a query returns it to the dashboard" — that must hold at scale.

This section is a decision guide: what each store is good at, how it behaves
serving **raw rows** vs **aggregations**, and where each one falls out of a 2 s
budget as data volume climbs.

### The three stores are not interchangeable

| | **RisingWave** | **TimescaleDB** | **Athena / Iceberg (S3)** |
|---|---|---|---|
| Model | Streaming MV engine (incremental compute) | Relational time-series (Postgres + hypertables) | Query engine over columnar files in S3 |
| Where the work happens | **At write time** — the MV is kept up to date as events arrive | **At read time** — scans rows on each query | **At read time** — scans object storage, cold start per query |
| Best at | Pre-defined aggregations, always-current, push | Ad-hoc SQL over recent raw rows; range scans | Cheap retention of unlimited history; large scans |
| Freshness driver | Checkpoint-barrier cadence (~sub-second, sawtooth) | Ingestion sink flush (per-row visible) | Batch/compaction into S3 (minutes) |
| Read latency driver | Fixed distributed-query overhead (planning + compute hop) | Rows scanned (index/chunk exclusion decisive) | S3 round-trip + planning (seconds floor) |
| Cost driver | Compute nodes kept warm 24/7 | Storage + compute of the DB instance | Per-query bytes scanned (near-zero at rest) |

The single most important idea: **RisingWave moves aggregation cost to write
time; TimescaleDB and Athena pay it at read time.** That one difference explains
every latency number on the dashboard.

### Serving *raw* data (point lookups & recent-window scans)

"Give me the last N readings for site X," or "the newest row per site."

| Store | At 3 devices | At ~3,000 devices (300 sites) | Notes |
|---|---|---|---|
| **TimescaleDB** | **~5–80 ms** | **10–150 ms** *if the query is time-bounded* | Winner for raw reads. A `partition_time > now() - interval` predicate lets it do **chunk exclusion** — it touches only the newest chunk regardless of total table size. On slot90's 6.9 M-row table this was the difference between **~11 ms and ~1.8 s** (and tens of seconds under load). Without a time bound, cost grows with total rows and blows the budget. |
| **RisingWave** | ~25–45 ms | ~30–80 ms | Flat, but a fixed floor: even a 9-row read pays distributed planning + a compute hop. Not built for arbitrary raw scans — it serves the *specific* rows its MVs materialise. |
| **Athena** | **1–3 s** | **2–10 s+** | Never inside a 2 s interactive budget for point reads. S3 round-trip + query planning is a seconds-floor cost paid on every query. Fine for "scan a month of history," wrong for "the latest value." |

**Takeaway for raw reads:** TimescaleDB, and the time-window predicate is
mandatory, not optional. It is the whole reason the store stays inside budget as
the hypertable grows — the fix applied to both the dashboard query and the CLI
block above. Athena is disqualified for interactive raw lookups.

### Serving *aggregations* (rates, rollups, fleet summaries)

"Average pump pressure per site over the last minute," "10-second pump-rate," etc.
This is where the write-time vs read-time split decides everything.

| Store | Approach | Latency at scale | When it breaks the 2 s budget |
|---|---|---|---|
| **RisingWave** | MV computed **incrementally at write time**; the read is a keyed lookup of an already-computed result | **Flat** — independent of history size, because the aggregate is maintained, not recomputed | Effectively never on read; the pressure moves to **compute-node sizing** and **checkpoint cadence**, not query time |
| **TimescaleDB** | Two modes: **(a)** raw `GROUP BY` at read time, or **(b)** a **continuous aggregate** (see [Block 4](block-4-timescaledb.md)) — a materialised, incrementally-refreshed rollup | (a) grows with rows scanned — **breaks budget** once the window ×  fleet size gets large; (b) flat, like RisingWave, because it's pre-materialised | Mode (a) at high cardinality / wide windows; mode (b) stays in budget |
| **Athena** | Full scan-and-aggregate over S3 objects each query | Seconds-to-minutes; scales with bytes scanned | Almost always for interactive use; it's a reporting/backfill tier |

**Takeaway for aggregations:** if the aggregation is known ahead of time (it
usually is — "pump rate," "free CPU," "throughput per site"), **materialise it**.
RisingWave does this natively for the streaming case; TimescaleDB's continuous
aggregates do it for the relational case. A materialised aggregate turns an
unbounded read-time scan into a flat keyed lookup — the only way either store
holds a 2 s budget at fleet scale. Recomputing aggregates from raw rows on every
read is the anti-pattern that put TimescaleDB at 34 s on this very dashboard
before the window fix.

### Scale points and the 2-second budget

Reading the columns as fleet size climbs (1 Hz telemetry, ~10 sensors/device):

| Fleet | Rows/day (approx) | Raw point read | Known aggregation | History scan |
|---|---|---|---|---|
| **3 devices** (workshop) | ~2.6 M | All three trivially fast | All fast | Athena seconds |
| **300 devices** (~30 sites) | ~260 M | TSDB windowed ✅ / RW ✅ / Athena ✅⁠(slow) | RW MV ✅ / TSDB CAGG ✅ / TSDB raw ⚠️ | Athena ✅ / TSDB ⚠️ |
| **3,000 devices** (300 sites) | ~2.6 B | TSDB windowed ✅ / RW ✅ / **Athena ❌** (interactive) | **RW MV ✅ / TSDB CAGG ✅** / TSDB raw ❌ | **Athena ✅** (its home turf) / TSDB ❌ |
| **30,000+ devices** | ~26 B+ | RW ✅ / TSDB windowed ✅ *with partitioning/retention discipline* | RW MV ✅ / TSDB CAGG ✅ | Athena/Iceberg only |

✅ = comfortably inside 2 s · ⚠️ = inside budget only with the right predicate/index · ❌ = exceeds budget for interactive use

What holds the budget as you scale:

- **Never scan unbounded history on the read path.** Time-bound every raw query
  (chunk exclusion) and materialise every known aggregate (RW MV or TSDB
  continuous aggregate). This is the single highest-leverage rule.
- **RisingWave's read latency is flat with scale** because the work happened at
  write time — its scaling levers are compute-node sizing on EKS ([capstone scale
  notes](../07-capstone/block-2-scale.md)) and **checkpoint cadence**, not query
  tuning. Budget risk shows up as ingestion lag / checkpoint-commit delay, i.e.
  **freshness**, not read latency — as the worked example below shows, a
  mis-tuned barrier interval alone can put freshness minutes behind at trivial load.
- **TimescaleDB's read latency is flat *only* with the right access pattern** —
  a time predicate for raw, a continuous aggregate for rollups. Get those right
  and it's the lowest-latency store here; get them wrong and it's the first to
  blow the budget (as the pre-fix 34 s dashboard showed).
- **Athena is a retention/history tier, not an interactive one.** It gets
  *relatively* better as data volume grows (columnar scans over S3 are its design
  point), but its per-query seconds-floor keeps it outside a 2 s interactive
  budget regardless of scale. Use it for backfill, audits, and large historical
  scans — not the live panel.

!!! note "Why a live tier can show minutes of 'freshness' — and why it isn't a latency problem"
    If RisingWave (or TimescaleDB) reports **seconds-to-minutes** of freshness, the
    read path is not slow — the **newest row it has committed really is that old**.
    Freshness measures *data liveness*; query latency measures *read cost*. They
    move independently, and freshness has two very different causes:

    - **Upstream pause** (stopped/redeploying simulator, MSK consumer-lag spike):
      **every** tier goes stale together, because they all read the same MSK
      topics. Fresh-vs-stale is uniform across stores.
    - **Per-store pipeline lag**: **one** tier drifts while the others stay
      current. This is the tell that the problem is *inside* that store's
      write/commit path, not upstream.

    Because both present as "stale data with a fast query," you diagnose by
    comparing stores side-by-side on the dashboard — and, critically, by measuring
    freshness against a **trusted external clock**, not the store's own `now()`.
    (RisingWave's `now()` tracks its last *committed* epoch, so when its commit path
    lags, `now()` lags too and `now() − MAX(ts)` computed inside RisingWave cancels
    the lag out — it looks sub-second while the data is minutes old. The dashboard
    and the CLI blocks above use the pod's wall-clock `Date.now()` precisely so the
    lag can't hide.)

!!! example "Worked example — RisingWave lagging 2+ minutes at 3-device load (a per-store checkpoint problem)"
    On slot90, RisingWave freshness climbed to **120–240 s and kept growing**, while
    TimescaleDB — reading the *same* MSK topics — stayed at **~1 s**. Only one tier
    lagged, so this was a per-store pipeline problem, not an upstream pause. Read
    latency stayed **~25–45 ms** throughout: the read was fast, the data was old.

    The cause was **checkpoint cadence**. RisingWave commits a checkpoint to its
    meta store on every *barrier*; the deployment had `RW_BARRIER_INTERVAL_MS` set
    to **50** (20 checkpoints/second, vs the RisingWave default of 1000). On a
    1-vCPU compute node with an external meta/state store, the commit path couldn't
    finish a checkpoint in 50 ms, so the committed epoch fell steadily behind
    wall-clock and never recovered — pure backlog in the commit path, even though
    the Kafka consumer was reading within a handful of messages of the topic head.

    Restoring the default (`barrierIntervalMs: 1000` in the chart) dropped freshness
    from ~150 s to **sub-second immediately**, with no change to CPU or memory. The
    lesson for the 2 s budget: **RisingWave's budget risk is a write-side tuning
    problem (checkpoint cadence, compute sizing), not a query problem** — and a tier
    that is stale-but-fast-to-read is the signature of exactly this class of bug.

!!! example "Worked example — a freshness spike to 100 s+ that is really node instability (not RisingWave)"
    A second, distinct cause of a big freshness number: the **node** under the
    streaming stack recycles. On the shared workshop EKS every node is a burstable
    `t3.medium` (~3.4 Gi, ~1.9 vCPU allocatable), and the analytics pod *limits*
    oversubscribe it (observed **163 % memory / 155 % CPU** of a single node's
    allocatable). When one such node flaps to `NodeNotReady`, it evicts whatever
    streaming/stateful pods share it at once — live on slot90 a single node event
    took down RisingWave compute **and**, on another slot, TimescaleDB (failover) +
    the redpanda-connect sink together. During the flap RisingWave's Kafka sources
    report `AllBrokersDown`, the committed MV epoch falls far behind wall-clock, and
    a dashboard read that lands mid-disruption shows **100 s+** (159.5 s observed).
    Once the node stabilised the same MV read at **856 ms** — proving the spike was
    transient node instability, not steady-state RisingWave behaviour.

    Tell it apart from the checkpoint-cadence case above by looking at pod restarts
    and node events, not just the freshness number:

    ```bash
    kubectl get events -n ws-slot00 --field-selector reason=NodeNotReady
    kubectl get pods  -n ws-slot00 -o wide   # RESTARTS ages clustered together + shared NODE = one node took them all
    ```

    The chart's mitigation (`risingwave.podAntiAffinity` + `timescaledb.affinity`,
    both **`preferred`**) spreads RW meta, RW compute and the TimescaleDB primary
    across separate nodes so no single node event can down the whole tier at once —
    that's the resilience layer for the pods that still share `workshop-nodes`
    (RW meta/frontend/compactor, TimescaleDB, the dashboard). RW **compute**
    specifically — the pod whose commit path drives both the freshness number and
    the `now()` skew below — no longer shares that pool at all: see
    [RW-Compute Node Sizing](#rw-compute-node-sizing) next.

## RW-Compute Node Sizing

[#211](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/issues/211)
moved RisingWave **compute** off the shared, burstable `t3.medium` pool onto a
dedicated, memory-optimized, non-burstable `r6i.xlarge` node group
(`amplify/custom/platform-stack.ts`, node group `rw-compute`) — one shared pool
for the whole cluster, not one per slot, since the fix is about eliminating
CPU starvation from co-located pods, not about isolating slots from each other.
A burstable `t`-family instance's CPU credits were the actual root cause of
both the ~10 s steady-state freshness lag and the `now()`/MV-epoch clock skew
(#206): compute was CFS-throttled 10–29 % of scheduling periods, which starved
the checkpoint-barrier commit path and dragged RisingWave's internal watermark
clock behind wall-clock — that skew *is* the freshness number. On `r6i.xlarge`
throttling dropped to 0.58 % and freshness to ~2.3 s avg (0.9–3.9 s).

`helm/cloud-analytics`'s `risingwave.compute.dedicatedNodePool` (default
**enabled**) sets the `nodeSelector`/`tolerations` that land the compute pod on
that node group; `computeTotalMemoryBytes` and `resources.compute` are sized to
match:

??? example "View source — compute node sizing (helm/cloud-analytics/values.yaml)"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/helm/cloud-analytics/values.yaml){ .md-button target=_blank }

    ```yaml
    --8<-- "helm/cloud-analytics/values.yaml:compute-sizing"
    ```

Disable `dedicatedNodePool.enabled` only when deploying this chart against a
cluster that doesn't have the `rw-compute` node group (e.g. local/minikube
smoke-testing) — on the shared workshop EKS it should always stay on.

---

## Chart 2 — Fleet Free CPU & Memory

Pulls `cpu_pct` and `mem_used_pct` sensor values from `mv_sensor_fleet_latest` (RisingWave) or `sensor_readings` (TimescaleDB), averages them across all nodes, and displays `100 - value` as "free" percentage.

!!! note "Why the two bars are nearly identical"
    Both databases read the same underlying data from MSK. The difference, if any, reflects propagation lag: TimescaleDB rows arrive via Redpanda Connect's 1-second batch window, so at any instant its averages may lag RisingWave by up to ~2 s.

---

## Chart 3 — Time Since Last Message per Node

Shows how recently each node sent a message, as seen independently by RisingWave and TimescaleDB. In steady state both should be ≤ 2 s (1 Hz publish + pipeline latency). A node going dark (no messages) will show an increasing bar, making it easy to spot a disconnected device.

The node label is shortened from `ws-slot00-edge-0` to `edge-0` for readability.

---

## How the Push Path Works

RisingWave and TimescaleDB both push updates to the browser instead of being polled — no `setInterval` for either live tier. Each has a server-side relay route in the dashboard app that holds one long-lived database connection and fans out over Server-Sent Events:

```
Browser
  │  EventSource → /api/stream/risingwave (SSE)
  ▼
Next.js Route Handler
  │  pg connection: DECLARE ... SUBSCRIPTION CURSOR FOR dashboard_freshness_sub
  │  loop: FETCH FROM cursor → re-run freshness query → push as SSE event
  ▼
RisingWave (Block 2's dashboard_freshness_sub)

Browser
  │  EventSource → /api/stream/timescaledb (SSE)
  ▼
Next.js Route Handler
  │  pg connection: LISTEN sensor_readings_change
  │  on NOTIFY → re-run freshness query → push as SSE event
  ▼
TimescaleDB (trigger: notify_sensor_reading() → pg_notify, once per INSERT
             *statement* into sensor_readings, not per row — see
             k8s/timescaledb-cloud-cluster.yaml)
```

RisingWave's native subscription cursor and Postgres's `LISTEN`/`NOTIFY` are both wire-protocol primitives — neither needs an external broker. The browser can't hold a persistent pg connection itself, so each route keeps one open server-side and relays over SSE.

??? example "View source — RisingWave push relay"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/cloud-dashboard/src/app/api/stream/risingwave/route.ts){ .md-button target=_blank }

    ```typescript
    --8<-- "cloud-dashboard/src/app/api/stream/risingwave/route.ts"
    ```

??? example "View source — TimescaleDB push relay"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/cloud-dashboard/src/app/api/stream/timescaledb/route.ts){ .md-button target=_blank }

    ```typescript
    --8<-- "cloud-dashboard/src/app/api/stream/timescaledb/route.ts"
    ```

**Athena and InfluxDB stay on-demand/polled** — neither exposes a subscribe primitive we use here (Athena is a warehouse query; Timestream for InfluxDB is a managed store we read with a Flux query, not a `LISTEN`/`SUBSCRIBE` cursor). The dashboard's `usePolledFreshness` hook calls `/api/freshness?tier=athena` on a 15-second `setInterval` and `/api/freshness?tier=influxdb` on a tighter 5-second one (InfluxDB's read is a fast time-series query, so it can afford a quicker cadence than the warehouse tier); those two intervals are the only ones left in the app, and they're deliberate. This is the practical contrast with the self-managed TimescaleDB tier next door — see [Block 5](block-5-timestream-influxdb.md) for why the managed store trades the push primitive for zero operational surface.

??? example "View source — dashboard page (push + poll hooks)"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/cloud-dashboard/src/app/page.tsx){ .md-button target=_blank }

    ```typescript
    --8<-- "cloud-dashboard/src/app/page.tsx"
    ```

Both live-tier hooks and the Athena poll return the same `FreshnessPayload` shape, so the three charts render identically regardless of how the data arrived:

??? example "View source — FreshnessPayload + on-demand route"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/cloud-dashboard/src/app/api/freshness/route.ts){ .md-button target=_blank }

    ```typescript
    --8<-- "cloud-dashboard/src/app/api/freshness/route.ts"
    ```

---

## Connecting to Live Databases

The chart wired above by `helm/cloud-analytics` sets `RISINGWAVE_ENDPOINT`, `TIMESCALEDB_ENDPOINT`, and the four `INFLUXDB_*` vars automatically from in-cluster service DNS, the CNPG-generated credentials Secret, and the per-slot `influxdb-credentials` Secret — nothing to configure for a deployed slot. The dashboard falls back to mock data (and a `⚠ Mock data` banner) only when these are unset, e.g. running the app locally outside the cluster:

```text
# RisingWave — PostgreSQL wire protocol on port 4567
RISINGWAVE_ENDPOINT=postgres://root@risingwave-cloud-frontend.ws-slot00.svc:4567/dev

# TimescaleDB — standard Postgres on port 5432
TIMESCALEDB_ENDPOINT=postgres://workshop:<password>@timescaledb-cloud-rw.ws-slot00.svc:5432/edge

# Timestream for InfluxDB — managed hot tier (Block 5). url/token/org/bucket
# come from the per-slot influxdb-credentials Secret the provision Job mints.
INFLUXDB_ENDPOINT=https://<instance-endpoint>:8086
INFLUXDB_TOKEN=<per-slot read/write token>
INFLUXDB_ORG=workshop
INFLUXDB_BUCKET=workshop-ws-slot00

# Athena / Iceberg — the warehouse tier. Only the Glue database name is
# required; the workgroup, table, and (optional) per-slot filter default sanely.
ATHENA_DATABASE=workshop_telemetry
# ATHENA_WORKGROUP=workshop-shared          # default
# ATHENA_TABLE=telemetry                    # default
# WORKSHOP_DEPLOYMENT_ID=ws-slot00          # optional: scope to one slot's rows
```

The Athena tier needs no endpoint — it uses the dashboard pod's IAM role to call Athena, so that role must allow `athena:StartQueryExecution` / `GetQueryExecution` / `GetQueryResults`, Glue read on `workshop_telemetry`, and read/write on the workgroup's S3 results location. When `ATHENA_DATABASE` (or, for the managed tier, `INFLUXDB_ENDPOINT`) is unset that tier falls back to mock data, exactly like the two live DBs.
