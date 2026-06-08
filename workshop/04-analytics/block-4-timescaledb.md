# Block 4 — TimescaleDB Continuous Aggregates

**Duration:** 45 min

---

## Connect to TimescaleDB

```bash
kubectl port-forward -n cnpg-system svc/timescaledb-rw 5432:5432 &
psql -h localhost -p 5432 -U workshop -d telemetry
```

---

## Create a Continuous Aggregate

```sql
-- Hourly CPU summary (pre-computes on new data)
CREATE MATERIALIZED VIEW cpu_hourly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', message_timestamp) AS bucket,
  thing_name,
  AVG(cpu_pct) AS avg_cpu,
  MAX(cpu_pct) AS max_cpu
FROM telemetry_raw
GROUP BY bucket, thing_name;

-- Add a refresh policy
SELECT add_continuous_aggregate_policy('cpu_hourly',
  start_offset      => INTERVAL '3 hours',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '30 minutes');
```

---

## Enable Real-Time Aggregation

By default the CAGG is `materialized_only = true` — data newer than the last refresh is silently excluded. Enable real-time aggregation to fill the gap:

```sql
ALTER MATERIALIZED VIEW cpu_hourly
  SET (timescaledb.materialized_only = false);
```

With this set, a plain `SELECT` is transparently rewritten by the query planner:

```sql
-- What the planner actually executes:
SELECT * FROM <materialization_hypertable>
UNION ALL
SELECT time_bucket('1 hour', message_timestamp), thing_name,
       AVG(cpu_pct), MAX(cpu_pct)
FROM telemetry_raw
WHERE message_timestamp > <materialization_watermark>
GROUP BY 1, 2;
```

This is structurally identical to **Hudi MoR**: the materialization hypertable is the base file, the raw un-refreshed chunks are the delta log, and the query-time UNION ALL is the merge reader.

---

## Workshop Exercise

Compare freshness with real-time aggregation on vs off:

```sql
-- With materialized_only = true: latest bucket may be ~1h stale
SELECT MAX(bucket) AS latest_bucket FROM cpu_hourly;

-- After ALTER ... SET (timescaledb.materialized_only = false):
-- Latest bucket now reflects data up to NOW()
SELECT MAX(bucket) AS latest_bucket FROM cpu_hourly;
```

---

## RisingWave MV vs TimescaleDB CAGG

| | TimescaleDB CAGG (`materialized_only=false`) | RisingWave MV |
|---|---|---|
| Freshness | Current at query time — live scan covers gap | Current continuously — incremental update on every write |
| Query latency (fresh data) | Higher — must scan + aggregate recent raw chunks | Low — always reading pre-computed state |
| Write-path cost | Near-zero — appends only | Higher — every write propagates through the MV DAG |
| Analogy | Hudi MoR (merge at read time) | Hudi CoW with no lag |

---

## Wrap-Up

Recap the three-tier freshness ladder: **RisingWave** (sub-second) → **TimescaleDB** (seconds) → **Hudi/Athena** (30–90 seconds).

**Preview Sessions 5–7:** Edge Kubernetes stack, simulated industrial site, and the HMI operator interface.

---

## References

- [TimescaleDB continuous aggregates](https://docs.timescale.com/use-timescale/latest/continuous-aggregates/)
- [TimescaleDB real-time aggregation](https://docs.timescale.com/use-timescale/latest/continuous-aggregates/real-time-aggregates/)
