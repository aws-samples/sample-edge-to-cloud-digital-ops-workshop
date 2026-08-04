# Block 5 — Live Analytics Dashboard

**Duration:** 30 min

---

## What You'll Build

A real-time web dashboard that polls RisingWave and TimescaleDB every 3 seconds — and the Athena/Iceberg warehouse tier every 15 seconds — then renders three live charts:

| Chart | Y axis | Source |
|---|---|---|
| **Data Freshness** | Milliseconds — **log scale** | All three tiers |
| **Fleet Free CPU & Memory** | Percent free (higher = healthier) | Both live DBs |
| **Time Since Last Message** | Seconds per node | Both live DBs |

All three stores serve the same telemetry, so you can directly compare how stale each store's view of the fleet is — a live streaming MV (RisingWave), a live relational scan (TimescaleDB), and an on-demand warehouse query (Athena over the Iceberg table in S3).

---

## Navigate to the Dashboard

Open the workshop app and click **Live Analytics Dashboard**, or go directly to `/dashboard`.

You should see three bar charts auto-updating every 3 seconds. If either database is not yet connected (env vars not set), the charts render with mock data and a warning banner.

---

## Chart 1 — Data Freshness (log scale)

The Y axis uses a **log₁₀ scale** because the three tiers span four orders of magnitude:

| Tier | Typical freshness |
|---|---|
| RisingWave MV | 100–600 ms |
| TimescaleDB (live scan) | 1–3 s |
| Athena/S3 | tens of s up to ~300 s |

A linear axis would make RisingWave and TimescaleDB indistinguishable — the log scale makes all three tiers clearly visible at once.

??? example "API query — RisingWave"
    ```sql
    SELECT
      site_id,
      MAX(ts_ms) AS latest_ts_ms
    FROM mv_sensor_fleet_latest
    GROUP BY site_id
    ```
    Freshness = `Date.now() - MAX(ts_ms)`. The `ts_ms` column stores `ingest_ts` — the epoch-ms timestamp stamped by IoT Core when the message arrived, not the device clock.

??? example "API query — TimescaleDB"
    ```sql
    SELECT
      site_id,
      MAX(ts_ms) AS latest_ts_ms
    FROM sensor_readings
    GROUP BY site_id
    ```
    Same query, same column semantics. Both use `ingest_ts` so clock-skew between EC2 edge nodes and the test runner is eliminated.

??? example "API query — Athena / Iceberg"
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

## Connecting to Live Databases

The dashboard falls back to mock data when the following environment variables are absent. Set them in your Next.js environment (`.env.local` for local dev, or the EKS deployment's ConfigMap/Secret):

```text
# RisingWave — PostgreSQL wire protocol on port 4567
RISINGWAVE_ENDPOINT=postgres://root@<risingwave-frontend-svc>:4567/dev

# TimescaleDB — standard Postgres on port 5432
TIMESCALEDB_ENDPOINT=postgres://workshop:<password>@<timescaledb-rw-svc>:5432/edge

# Athena / Iceberg — the warehouse tier. Only the Glue database name is
# required; the workgroup, table, and (optional) per-slot filter default sanely.
ATHENA_DATABASE=workshop_telemetry
# ATHENA_WORKGROUP=workshop-shared          # default
# ATHENA_TABLE=telemetry                    # default
# WORKSHOP_DEPLOYMENT_ID=ws-slot00          # optional: scope to one slot's rows
```

The two `*_ENDPOINT` values are available after completing Block 1. The Athena
tier needs no endpoint — it uses your task/pod IAM role to call Athena, so the
role must allow `athena:StartQueryExecution` / `GetQueryExecution` /
`GetQueryResults`, Glue read on `workshop_telemetry`, and read/write on the
workgroup's S3 results location. When `ATHENA_DATABASE` is unset the Athena tier
falls back to mock data, exactly like the two live DBs.

---

## How the API Route Works

Each tier's chart datasets come from a single call to `/api/freshness?tier=risingwave` (or `timescaledb`, or `athena`). The route handler runs one query per tier, computes freshness from `Date.now() - MAX(...)`, and returns a typed `FreshnessPayload` object:

```typescript
interface FreshnessPayload {
  tierFreshness: { risingwave_ms, timescaledb_ms, athena_ms };
  fleetResources: { avg_free_cpu_pct, avg_free_mem_pct };
  nodeAge: Array<{ site_id, age_seconds }>;
  source: "risingwave" | "timescaledb" | "athena" | "mock";
  sampled_at: number;
}
```

The dashboard calls the two live endpoints every 3 seconds and the Athena
endpoint every 15 seconds (it's a slow warehouse query, not a live push) using
`setInterval` inside a `useEffect`, then passes all three payloads to the
freshness chart so it can render the tiers side-by-side.
