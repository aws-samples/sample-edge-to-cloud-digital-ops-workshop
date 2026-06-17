-- RisingWave DDL — cloud EKS instance
-- Run once after deploying risingwave-operator + risingwave-cloud.yaml and
-- applying the MSK credentials Secret.
--
-- Connect (substitute your deployment ID and MSK broker addresses):
--   kubectl port-forward -n ws-slot00 svc/risingwave-cloud-frontend 4567:4567
--   # Then in another terminal, substitute and run:
--   MSK_BOOTSTRAP="<your-bootstrap-servers>"
--   MSK_USER="workshop-ws-slot00"
--   MSK_PASS="$(aws secretsmanager get-secret-value --secret-id /workshop/ws-slot00/msk-credentials --query SecretString --output text | python3 -c 'import sys,json; print(json.load(sys.stdin)["password"])')"
--   sed -e "s|__MSK_BOOTSTRAP__|$MSK_BOOTSTRAP|g" \
--       -e "s|__MSK_USER__|$MSK_USER|g" \
--       -e "s|__MSK_PASS__|$MSK_PASS|g" \
--       risingwave/ddl-cloud.sql | psql -h localhost -p 4567 -U root -d dev
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
    message_timestamp  BIGINT
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
    SELECT 'cpu_pct'           AS sensor, thing_name AS site_id, cpu_pct                    AS value, 'percent' AS unit, message_timestamp AS ts_ms FROM sensors_raw_telemetry
    UNION ALL
    SELECT 'mem_used_pct'      AS sensor, thing_name AS site_id, mem_used_pct               AS value, 'percent' AS unit, message_timestamp AS ts_ms FROM sensors_raw_telemetry
    UNION ALL
    SELECT 'disk_used_pct'     AS sensor, thing_name AS site_id, disk_used_pct              AS value, 'percent' AS unit, message_timestamp AS ts_ms FROM sensors_raw_telemetry
    UNION ALL
    SELECT 'net_io_bytes_sent' AS sensor, thing_name AS site_id, net_io_bytes_sent::DOUBLE  AS value, 'bytes'   AS unit, message_timestamp AS ts_ms FROM sensors_raw_telemetry
    UNION ALL
    SELECT 'net_io_bytes_recv' AS sensor, thing_name AS site_id, net_io_bytes_recv::DOUBLE  AS value, 'bytes'   AS unit, message_timestamp AS ts_ms FROM sensors_raw_telemetry
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
    SELECT 'cpu_pct'           AS sensor, thing_name AS site_id, cpu_pct                   AS value, message_timestamp AS ts_ms FROM sensors_raw_telemetry
    UNION ALL
    SELECT 'mem_used_pct'      AS sensor, thing_name AS site_id, mem_used_pct              AS value, message_timestamp AS ts_ms FROM sensors_raw_telemetry
    UNION ALL
    SELECT 'disk_used_pct'     AS sensor, thing_name AS site_id, disk_used_pct             AS value, message_timestamp AS ts_ms FROM sensors_raw_telemetry
    UNION ALL
    SELECT 'net_io_bytes_sent' AS sensor, thing_name AS site_id, net_io_bytes_sent::DOUBLE AS value, message_timestamp AS ts_ms FROM sensors_raw_telemetry
    UNION ALL
    SELECT 'net_io_bytes_recv' AS sensor, thing_name AS site_id, net_io_bytes_recv::DOUBLE AS value, message_timestamp AS ts_ms FROM sensors_raw_telemetry
) combined
GROUP BY sensor, site_id, (ts_ms / 60000);
