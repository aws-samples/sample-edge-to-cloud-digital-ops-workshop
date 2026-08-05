-- RisingWave DDL — cloud EKS instance
--
-- Applied automatically by the post-install/post-upgrade Job in
-- helm/cloud-analytics/templates/risingwave-ddl-job.yaml (mirrors the pattern
-- in helm/edge-stack/templates/risingwave-ddl-job.yaml) — the Job reads the
-- __MSK_BOOTSTRAP__/__MSK_USER__/__MSK_PASS__ placeholders below from the
-- in-cluster `msk-credentials` Secret and substitutes them itself, then pipes
-- the result through psql. No manual sed/psql step (see #159).
--
-- To re-apply by hand for debugging, port-forward the frontend service and
-- substitute the same three placeholders yourself:
--   kubectl port-forward -n ws-slot00 svc/risingwave-cloud-frontend 4567:4567
--
-- Notes on topic naming:
--   MSK topics are named sensors.raw.<site-id> where site-id matches the edge node.
--   Create one source per topic (RisingWave does not support wildcard topics).
--   For a multi-site setup, UNION ALL multiple sources in the materialized views.

-- ─────────────────────────────────────────────────────────────────────────────
-- Source: raw sensor telemetry from MSK (sim site — normalised sensor schema)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE SOURCE IF NOT EXISTS sensors_raw_cloud (
    sensor    VARCHAR,
    site_id   VARCHAR,
    value     DOUBLE,
    unit      VARCHAR,
    ts_ms     BIGINT
)
WITH (
    connector                        = 'kafka',
    topic                            = 'sensors.raw.sim',
    properties.bootstrap.server      = '__MSK_BOOTSTRAP__',
    properties.security.protocol     = 'SASL_SSL',
    properties.sasl.mechanism        = 'SCRAM-SHA-512',
    properties.sasl.username         = '__MSK_USER__',
    properties.sasl.password         = '__MSK_PASS__',
    scan.startup.mode                = 'latest'
)
FORMAT PLAIN ENCODE JSON;

-- ─────────────────────────────────────────────────────────────────────────────
-- Source: flat IoT node telemetry (cpu/mem/disk/net from EC2 instances via IoT Core)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE SOURCE IF NOT EXISTS sensors_raw_telemetry (
    thing_name         VARCHAR,
    cpu_pct            DOUBLE,
    mem_used_pct       DOUBLE,
    disk_used_pct      DOUBLE,
    net_io_bytes_sent  BIGINT,
    net_io_bytes_recv  BIGINT,
    message_timestamp  BIGINT,
    ingest_ts          BIGINT
)
WITH (
    connector                        = 'kafka',
    topic                            = 'raw.telemetry',
    properties.bootstrap.server      = '__MSK_BOOTSTRAP__',
    properties.security.protocol     = 'SASL_SSL',
    properties.sasl.mechanism        = 'SCRAM-SHA-512',
    properties.sasl.username         = '__MSK_USER__',
    properties.sasl.password         = '__MSK_PASS__',
    scan.startup.mode                = 'latest'
)
FORMAT PLAIN ENCODE JSON;

-- ─────────────────────────────────────────────────────────────────────────────
-- Materialized view: latest reading per sensor per site across the entire fleet.
-- Unions industrial sensor data (sensors_raw_cloud) with IoT node telemetry
-- (sensors_raw_telemetry unpivoted into per-metric rows).
-- Uses array_agg ORDER BY to pick the value with the highest ts_ms.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_sensor_fleet_latest AS
SELECT
    sensor,
    site_id,
    (array_agg(value ORDER BY ts_ms DESC))[1]  AS value,
    (array_agg(unit  ORDER BY ts_ms DESC))[1]  AS unit,
    MAX(ts_ms)                                  AS ts_ms
FROM (
    SELECT sensor, site_id, value, unit, ts_ms FROM sensors_raw_cloud
    UNION ALL
    SELECT 'cpu_pct'           AS sensor, thing_name AS site_id, cpu_pct                    AS value, 'percent' AS unit, ingest_ts AS ts_ms FROM sensors_raw_telemetry
    UNION ALL
    SELECT 'mem_used_pct'      AS sensor, thing_name AS site_id, mem_used_pct               AS value, 'percent' AS unit, ingest_ts AS ts_ms FROM sensors_raw_telemetry
    UNION ALL
    SELECT 'disk_used_pct'     AS sensor, thing_name AS site_id, disk_used_pct              AS value, 'percent' AS unit, ingest_ts AS ts_ms FROM sensors_raw_telemetry
    UNION ALL
    SELECT 'net_io_bytes_sent' AS sensor, thing_name AS site_id, net_io_bytes_sent::DOUBLE  AS value, 'bytes'   AS unit, ingest_ts AS ts_ms FROM sensors_raw_telemetry
    UNION ALL
    SELECT 'net_io_bytes_recv' AS sensor, thing_name AS site_id, net_io_bytes_recv::DOUBLE  AS value, 'bytes'   AS unit, ingest_ts AS ts_ms FROM sensors_raw_telemetry
) combined
GROUP BY sensor, site_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- Materialized view: 1-minute tumbling window averages per sensor per site.
-- Buckets by (ts_ms / 60000) integer division — no watermark required.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_fleet_1min_avg AS
SELECT
    sensor,
    site_id,
    AVG(value)                                            AS avg_value,
    MIN(value)                                            AS min_value,
    MAX(value)                                            AS max_value,
    COUNT(*)                                              AS sample_count,
    to_timestamp((ts_ms / 60000) * 60)                   AS window_start,
    to_timestamp((ts_ms / 60000) * 60 + 60)              AS window_end
FROM (
    SELECT sensor, site_id, value, ts_ms FROM sensors_raw_cloud
    UNION ALL
    SELECT 'cpu_pct'           AS sensor, thing_name AS site_id, cpu_pct                   AS value, ingest_ts AS ts_ms FROM sensors_raw_telemetry
    UNION ALL
    SELECT 'mem_used_pct'      AS sensor, thing_name AS site_id, mem_used_pct              AS value, ingest_ts AS ts_ms FROM sensors_raw_telemetry
    UNION ALL
    SELECT 'disk_used_pct'     AS sensor, thing_name AS site_id, disk_used_pct             AS value, ingest_ts AS ts_ms FROM sensors_raw_telemetry
    UNION ALL
    SELECT 'net_io_bytes_sent' AS sensor, thing_name AS site_id, net_io_bytes_sent::DOUBLE AS value, ingest_ts AS ts_ms FROM sensors_raw_telemetry
    UNION ALL
    SELECT 'net_io_bytes_recv' AS sensor, thing_name AS site_id, net_io_bytes_recv::DOUBLE AS value, ingest_ts AS ts_ms FROM sensors_raw_telemetry
) combined
GROUP BY sensor, site_id, (ts_ms / 60000);

-- ─────────────────────────────────────────────────────────────────────────────
-- Subscription: change feed on mv_sensor_fleet_latest for the cloud dashboard's
-- push path (#160). A server-side consumer (cloud-dashboard's
-- /api/stream/risingwave route) declares a SUBSCRIPTION CURSOR against this
-- and relays each change event to the browser over SSE — no client polling.
-- Retention window bounds how far a newly-connected cursor can look back.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE SUBSCRIPTION IF NOT EXISTS dashboard_freshness_sub
FROM mv_sensor_fleet_latest
WITH (retention = '1D');
