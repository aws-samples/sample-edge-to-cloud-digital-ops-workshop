-- RisingWave DDL — cloud EKS instance
-- Run once after deploying risingwave-operator + risingwave-cloud.yaml and
-- applying the MSK credentials Secret.
--
-- Connect:
--   psql -h <risingwave-svc> -p 4566 -U root -f risingwave/ddl-cloud.sql
-- (after: kubectl port-forward -n risingwave svc/risingwave-cloud-frontend 4566:4566)
--
-- MSK credentials must be available as env vars in the RisingWave pods
-- (injected from the msk-credentials Secret — see k8s/risingwave-cloud.yaml).
-- RisingWave substitutes ${VAR} at DDL parse time for WITH properties.

-- ─────────────────────────────────────────────────────────────────────────────
-- Source: all raw sensor telemetry from MSK
-- Reads sensors.raw.* topics using SASL/SCRAM-512.
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
    topic                            = 'sensors.raw.*',
    properties.bootstrap.server      = '${MSK_BOOTSTRAP_SERVERS}',
    properties.security.protocol     = 'SASL_SSL',
    properties.sasl.mechanism        = 'SCRAM-SHA-512',
    properties.sasl.username         = '${MSK_USERNAME}',
    properties.sasl.password         = '${MSK_PASSWORD}',
    scan.startup.mode                = 'latest'
)
FORMAT PLAIN ENCODE JSON;

-- ─────────────────────────────────────────────────────────────────────────────
-- Materialized view: latest reading per sensor per site across the entire fleet
-- ─────────────────────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_sensor_fleet_latest AS
SELECT
    sensor,
    site_id,
    value,
    unit,
    ts_ms
FROM sensors_raw_cloud
WHERE ts_ms = (
    SELECT MAX(ts_ms)
    FROM sensors_raw_cloud s2
    WHERE s2.sensor  = sensors_raw_cloud.sensor
      AND s2.site_id = sensors_raw_cloud.site_id
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Materialized view: 1-minute tumbling window averages per sensor per site
-- ─────────────────────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_fleet_1min_avg AS
SELECT
    sensor,
    site_id,
    AVG(value)   AS avg_value,
    MIN(value)   AS min_value,
    MAX(value)   AS max_value,
    COUNT(*)     AS sample_count,
    window_start,
    window_end
FROM TUMBLE(sensors_raw_cloud, proctime(), INTERVAL '1' MINUTE)
GROUP BY sensor, site_id, window_start, window_end;
