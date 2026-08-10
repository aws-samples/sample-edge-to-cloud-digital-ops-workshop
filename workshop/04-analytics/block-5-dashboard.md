# Block 5 — Live Analytics Dashboard

**Duration:** 30 min

---

## What You've Been Looking At

If you opened the dashboard at the start of this section (Block 1), you've already seen it: three live charts comparing the same telemetry as served by RisingWave, TimescaleDB, and Athena/Iceberg side by side.

| Chart | Y axis | Source |
|---|---|---|
| **Data Freshness** | Milliseconds — **log scale** | All three tiers |
| **Fleet Free CPU & Memory** | Percent free (higher = healthier) | Both live DBs |
| **Time Since Last Message** | Seconds per node | Both live DBs |

All three stores serve the same telemetry, so you can directly compare how stale each store's view of the fleet is — a live streaming MV (RisingWave), a live relational scan (TimescaleDB), and an on-demand warehouse query (Athena over the Iceberg table in S3). This block explains how each chart gets its data.

If you don't already have it open:

```bash
kubectl port-forward -n ws-slot00 svc/cloud-analytics-dashboard 3000:3000 > /tmp/dashboard-pf.log 2>&1 &
DASH_PF_PID=$!
until grep -q "Forwarding from" /tmp/dashboard-pf.log 2>/dev/null; do sleep 1; done
curl -sf http://localhost:3000 | head -c 200
kill "$DASH_PF_PID" 2>/dev/null || true
```
<!-- e2e:assert {"contains": "<"} -->

Or keep the port-forward running in a separate terminal and open `http://localhost:3000` in a browser. The RisingWave and TimescaleDB indicators show `live · push`; Athena shows `live · poll`. If either live tier shows `(mock)`, the dashboard's endpoint env vars aren't wired to a live store yet — see [Connecting to Live Databases](#connecting-to-live-databases) below.

---

## Chart 1 — Data Freshness (log scale)

The Y axis uses a **log₁₀ scale** because the three tiers span four orders of magnitude:

| Tier | Typical freshness |
|---|---|
| RisingWave MV | 100–600 ms |
| TimescaleDB (live scan) | 1–3 s |
| Athena/S3 | tens of s up to ~300 s |

A linear axis would make RisingWave and TimescaleDB indistinguishable — the log scale makes all three tiers clearly visible at once.

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

### CLI — read the same freshness numbers

The three panels above render in a browser, but the underlying metric is just
`now − MAX(timestamp)` per store — you can read it from the CLI with the exact
same queries the dashboard runs. Each block below prints a one-line JSON
`{"tier", "freshness_ms", "rows"}`. The freshness is computed **in-SQL**
(`now()` in epoch-ms minus the store's latest timestamp) so there's no dependency
on the client clock or a GNU-only `date` flag.

The end-to-end suite runs these blocks against a live slot and records each
tier's `freshness_ms` in the run report's **Data freshness** table, so the
three-tier freshness ladder is captured on every e2e pass — the CLI equivalent
of the dashboard's Data Freshness chart.

??? example "RisingWave freshness (port 4567)"
    ```bash
    kubectl port-forward -n ws-slot00 svc/risingwave-cloud-frontend 4567:4567 > /tmp/rw-fresh-pf.log 2>&1 &
    RW_PF_PID=$!
    until grep -q "Forwarding from" /tmp/rw-fresh-pf.log 2>/dev/null; do sleep 1; done
    # Same MV the dashboard's /api/stream/risingwave route reads. ts_ms is the
    # IoT-Core ingest timestamp (epoch-ms), so freshness is clock-skew-free.
    IFS='|' read -r RW_FRESH RW_ROWS < <(psql -h localhost -p 4567 -U root -d dev -tA -F'|' \
      -c "SELECT (EXTRACT(EPOCH FROM now())*1000)::bigint - MAX(ts_ms), COUNT(*) FROM mv_sensor_fleet_latest;")
    kill "$RW_PF_PID" 2>/dev/null || true
    echo "{\"tier\":\"risingwave\",\"freshness_ms\":${RW_FRESH:-null},\"rows\":${RW_ROWS:-0}}"
    ```
    <!-- e2e:assert {"captureFreshness": true} -->

??? example "TimescaleDB freshness (port 5432)"
    ```bash
    TSDB_PASS=$(kubectl get secret timescaledb-cloud-app -n ws-slot00 \
      -o jsonpath='{.data.password}' | base64 -d)
    kubectl port-forward -n ws-slot00 svc/timescaledb-cloud-rw 5432:5432 > /tmp/tsdb-fresh-pf.log 2>&1 &
    TSDB_PF_PID=$!
    until grep -q "Forwarding from" /tmp/tsdb-fresh-pf.log 2>/dev/null; do sleep 1; done
    # Same sensor_readings table the dashboard's /api/stream/timescaledb route reads.
    IFS='|' read -r TS_FRESH TS_ROWS < <(PGPASSWORD="$TSDB_PASS" psql -h localhost -p 5432 -U workshop -d edge -tA -F'|' \
      -c "SELECT (EXTRACT(EPOCH FROM now())*1000)::bigint - MAX(ts_ms), COUNT(*) FROM sensor_readings;")
    kill "$TSDB_PF_PID" 2>/dev/null || true
    echo "{\"tier\":\"timescaledb\",\"freshness_ms\":${TS_FRESH:-null},\"rows\":${TS_ROWS:-0}}"
    ```
    <!-- e2e:assert {"captureFreshness": true} -->

??? example "Athena / Iceberg freshness (no port-forward)"
    ```bash
    # Same Iceberg table + message_timestamp basis the dashboard's
    # /api/freshness?tier=athena route queries. Freshness here includes the
    # warehouse round-trip, so it's tens of seconds even when data is recent.
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
    # aws CLI renders a SQL NULL as the literal "None" in text output — normalise it.
    if [ "$AT_FRESH" = "None" ]; then AT_FRESH=""; fi
    if [ "$AT_ROWS" = "None" ]; then AT_ROWS=""; fi
    echo "{\"tier\":\"athena\",\"freshness_ms\":${AT_FRESH:-null},\"rows\":${AT_ROWS:-0}}"
    ```
    <!-- e2e:assert {"captureFreshness": true} -->

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
TimescaleDB (trigger: notify_sensor_reading() → pg_notify, on every INSERT
             into sensor_readings — see k8s/timescaledb-cloud-cluster.yaml)
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

**Athena stays on-demand/polled** — it's a warehouse query, not a live push, and has no subscribe primitive. The dashboard's `usePolledFreshness` hook calls `/api/freshness?tier=athena` on a 15-second `setInterval`; that's the one interval left in the app, and it's deliberate.

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

The chart wired above by `helm/cloud-analytics` sets `RISINGWAVE_ENDPOINT` and `TIMESCALEDB_ENDPOINT` automatically from in-cluster service DNS and the CNPG-generated credentials Secret — nothing to configure for a deployed slot. The dashboard falls back to mock data (and a `⚠ Mock data` banner) only when these are unset, e.g. running the app locally outside the cluster:

```text
# RisingWave — PostgreSQL wire protocol on port 4567
RISINGWAVE_ENDPOINT=postgres://root@risingwave-cloud-frontend.ws-slot00.svc:4567/dev

# TimescaleDB — standard Postgres on port 5432
TIMESCALEDB_ENDPOINT=postgres://workshop:<password>@timescaledb-cloud-rw.ws-slot00.svc:5432/edge

# Athena / Iceberg — the warehouse tier. Only the Glue database name is
# required; the workgroup, table, and (optional) per-slot filter default sanely.
ATHENA_DATABASE=workshop_telemetry
# ATHENA_WORKGROUP=workshop-shared          # default
# ATHENA_TABLE=telemetry                    # default
# WORKSHOP_DEPLOYMENT_ID=ws-slot00          # optional: scope to one slot's rows
```

The Athena tier needs no endpoint — it uses the dashboard pod's IAM role to call Athena, so that role must allow `athena:StartQueryExecution` / `GetQueryExecution` / `GetQueryResults`, Glue read on `workshop_telemetry`, and read/write on the workgroup's S3 results location. When `ATHENA_DATABASE` is unset the Athena tier falls back to mock data, exactly like the two live DBs.
