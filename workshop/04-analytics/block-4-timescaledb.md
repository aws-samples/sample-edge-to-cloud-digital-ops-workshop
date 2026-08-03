# Block 4 — TimescaleDB Continuous Aggregates

**Duration:** 45 min

---

## Connect to TimescaleDB

The CNPG primary (read-write) service is `timescaledb-cloud-rw` and the workshop database is `edge` (created by the cluster's `bootstrap.initdb`). The password is in the CNPG-generated `timescaledb-cloud-app` Secret:

```bash
TSDB_PASS=$(kubectl get secret timescaledb-cloud-app -n ws-slot00 \
  -o jsonpath='{.data.password}' | base64 -d)
kubectl port-forward -n ws-slot00 svc/timescaledb-cloud-rw 5432:5432 > /tmp/tsdb-cloud-pf.log 2>&1 &
TSDB_PF_PID=$!
sleep 5
PGPASSWORD="$TSDB_PASS" psql -h localhost -p 5432 -U workshop -d edge -c "SELECT 1;"
kill "$TSDB_PF_PID" 2>/dev/null || true
```
<!-- e2e:assert {"contains": "1 row"} -->

Or keep the port-forward running in a separate terminal and connect interactively with `PGPASSWORD="$TSDB_PASS" psql -h localhost -p 5432 -U workshop -d edge`.

!!! tip "Port 5432 already in use?"
    If you have a local PostgreSQL running, `psql -h localhost -p 5432` connects to *it*, not the forward. Map the forward to a free local port instead — `kubectl port-forward … 15432:5432` — and connect with `-p 15432`.

---

!!! info "This cluster runs the real TimescaleDB extension"
    `k8s/timescaledb-cloud-cluster.yaml` uses a CloudNativePG-compatible operand
    image with the `timescaledb` extension baked in and `create_hypertable()`
    already applied to `sensor_readings` — so the continuous-aggregate SQL below
    runs as-is. CNPG (not the image) still owns HA, failover, and backups; only
    the container image changed. All telemetry lands in one table,
    `sensor_readings(ts_ms, sensor, site_id, value, unit, partition_time)`, with
    one row per metric — CPU readings arrive as rows where `sensor = 'cpu_pct'`
    and `site_id` is the reporting thing name.

## Create a Continuous Aggregate

```sql
-- Hourly CPU summary (pre-computes on new data)
CREATE MATERIALIZED VIEW cpu_hourly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', partition_time) AS bucket,
  site_id,
  AVG(value) AS avg_cpu,
  MAX(value) AS max_cpu
FROM sensor_readings
WHERE sensor = 'cpu_pct'
GROUP BY bucket, site_id;

-- Add a refresh policy
SELECT add_continuous_aggregate_policy('cpu_hourly',
  start_offset      => INTERVAL '3 hours',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '30 minutes');
```

Apply it against the deployed cluster (safe to re-run — `CREATE ... IF NOT EXISTS`
and `add_continuous_aggregate_policy(..., if_not_exists => true)`):

```bash
TSDB_PASS=$(kubectl get secret timescaledb-cloud-app -n ws-slot00 \
  -o jsonpath='{.data.password}' | base64 -d)
kubectl port-forward -n ws-slot00 svc/timescaledb-cloud-rw 5432:5432 > /tmp/tsdb-cagg-pf.log 2>&1 &
TSDB_PF_PID=$!
sleep 5
PGPASSWORD="$TSDB_PASS" psql -h localhost -p 5432 -U workshop -d edge -v ON_ERROR_STOP=1 <<'SQL'
CREATE MATERIALIZED VIEW IF NOT EXISTS cpu_hourly
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', partition_time) AS bucket,
       site_id,
       AVG(value) AS avg_cpu,
       MAX(value) AS max_cpu
FROM sensor_readings
WHERE sensor = 'cpu_pct'
GROUP BY bucket, site_id;

SELECT add_continuous_aggregate_policy('cpu_hourly',
  start_offset      => INTERVAL '3 hours',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '30 minutes',
  if_not_exists     => true);
SQL
kill "$TSDB_PF_PID" 2>/dev/null || true
```
<!-- e2e:assert {"contains": "CREATE MATERIALIZED VIEW"} -->

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
SELECT time_bucket('1 hour', partition_time), site_id,
       AVG(value), MAX(value)
FROM sensor_readings
WHERE sensor = 'cpu_pct'
  AND partition_time > <materialization_watermark>
GROUP BY 1, 2;
```

This is structurally identical to **Iceberg's merge-on-read**: the materialization hypertable is the committed data file, the raw un-refreshed chunks are the uncommitted delta, and the query-time UNION ALL is the merge reader that reconciles them at query time.

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
| Analogy | Iceberg merge-on-read (merge at read time) | Iceberg copy-on-write with no lag |

---

## Wrap-Up

Recap the three-tier freshness ladder: **RisingWave** (sub-second) → **TimescaleDB** (seconds) → **Iceberg/Athena** (~300 seconds, up to ~15 minutes under low throughput).

**Preview Sessions 5–7:** Edge Kubernetes stack, simulated industrial site, and the HMI operator interface.

---

## References

- [TimescaleDB continuous aggregates](https://docs.timescale.com/use-timescale/latest/continuous-aggregates/)
- [TimescaleDB real-time aggregation](https://docs.timescale.com/use-timescale/latest/continuous-aggregates/real-time-aggregates/)
