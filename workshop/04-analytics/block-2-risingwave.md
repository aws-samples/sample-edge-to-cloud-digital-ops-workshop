# Block 2 — Create RisingWave Materialized Views

**Duration:** 45 min

---

## Connect to RisingWave

```bash
kubectl port-forward -n {DEPLOYMENT_ID} svc/risingwave 4566:4566 &
psql -h localhost -p 4566 -U root
```

---

## Create the Kafka Source

```sql
CREATE SOURCE telemetry_raw (
  thing_name          VARCHAR,
  cpu_pct             FLOAT,
  mem_used_pct        FLOAT,
  disk_used_pct       FLOAT,
  pump_rate_bbl_per_min FLOAT,
  message_timestamp   TIMESTAMPTZ
) WITH (
  connector = 'kafka',
  topic = 'raw.telemetry',
  properties.bootstrap.server = '{MSK_BOOTSTRAP}',
  scan.startup.mode = 'earliest'
) FORMAT PLAIN ENCODE JSON;
```

---

## Create Materialized Views

```sql
-- 5-minute rolling CPU window
CREATE MATERIALIZED VIEW cpu_5min AS
SELECT
  thing_name,
  window_start,
  AVG(cpu_pct) AS avg_cpu,
  MAX(cpu_pct) AS max_cpu
FROM TUMBLE(telemetry_raw, message_timestamp, INTERVAL '5 MINUTES')
GROUP BY thing_name, window_start;

-- Per-device latest disk usage + status
CREATE MATERIALIZED VIEW fleet_disk AS
SELECT
  thing_name,
  disk_used_pct,
  CASE WHEN disk_used_pct >= 80 THEN 'CRITICAL'
       WHEN disk_used_pct >= 60 THEN 'WARNING'
       ELSE 'OK'
  END AS disk_status,
  message_timestamp AS last_seen
FROM (
  SELECT DISTINCT ON (thing_name)
    thing_name, disk_used_pct, message_timestamp
  FROM telemetry_raw
  ORDER BY thing_name, message_timestamp DESC
);

-- Fleet-level summary
CREATE MATERIALIZED VIEW fleet_disk_summary AS
SELECT
  MAX(disk_used_pct)                              AS max_disk_pct,
  AVG(disk_used_pct)                              AS avg_disk_pct,
  COUNT(*) FILTER (WHERE disk_used_pct >= 80)     AS critical_count,
  COUNT(*) FILTER (WHERE disk_used_pct >= 60
                     AND disk_used_pct < 80)      AS warning_count,
  COUNT(*)                                        AS device_count
FROM fleet_disk;

-- Fleet pump rate (used in Session 4 freshness comparison)
CREATE MATERIALIZED VIEW current_pump_rate AS
SELECT SUM(pump_rate_bbl_per_min) AS total_rate
FROM telemetry_raw
WHERE message_timestamp > NOW() - INTERVAL '5 seconds';
```

Query the views and observe **sub-100 ms response times**.

!!! info "Why is the MV always fast?"
    RisingWave incrementally maintains each view using a streaming operator graph. On each new row, the aggregation is updated in memory — not recomputed from scratch. Read cost is always a single row lookup regardless of fleet size.

---

## Reference

- [RisingWave streaming SQL](https://docs.risingwave.com/sql/overview)
