-- RisingWave DDL — cloud EKS instance
-- Run once after deploying risingwave-operator + risingwave-cloud.yaml and
-- applying the MSK credentials Secret.
--
-- Connect (substitute your deployment ID):
--   kubectl port-forward -n ws-slot00 svc/risingwave-cloud-frontend 4566:4566
--   psql -h localhost -p 4566 -U root -f risingwave/ddl-cloud.sql
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
    MAX_BY(value, ts_ms)  AS value,
    MAX_BY(unit,  ts_ms)  AS unit,
    MAX(ts_ms)            AS ts_ms
FROM sensors_raw_cloud
GROUP BY sensor, site_id;

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
