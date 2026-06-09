-- RisingWave DDL — run once after Helm deploy, before starting the HMI
-- Connect: psql -h localhost -p 4566 -U root
-- (after: kubectl port-forward -n edge svc/edge-risingwave 4566:4566)

-- Source table: all raw sensor messages from Redpanda
-- Redpanda Connect writes JSON to topics sensors.raw.<sensor_name>
-- RisingWave reads via Kafka source, one source per topic pattern.
CREATE SOURCE IF NOT EXISTS sensors_raw (
    sensor    VARCHAR,
    site_id   VARCHAR,
    value     DOUBLE,
    unit      VARCHAR,
    ts_ms     BIGINT
)
WITH (
    connector = 'kafka',
    topic     = 'sensors.raw.*',
    properties.bootstrap.server = 'edge-stack-redpanda:9092',
    scan.startup.mode = 'latest'
)
FORMAT PLAIN ENCODE JSON;

-- Materialized view: latest reading per sensor per site
-- HMI /api/live-stream subscribes to this view.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_sensor_latest AS
SELECT
    sensor,
    site_id,
    value,
    unit,
    ts_ms
FROM sensors_raw
WHERE ts_ms = (
    SELECT MAX(ts_ms)
    FROM sensors_raw s2
    WHERE s2.sensor  = sensors_raw.sensor
      AND s2.site_id = sensors_raw.site_id
);

-- Materialized view: 1-minute rolling averages (used by Digital Ops page)
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_sensor_1min_avg AS
SELECT
    sensor,
    site_id,
    AVG(value)    AS avg_value,
    MIN(value)    AS min_value,
    MAX(value)    AS max_value,
    COUNT(*)      AS sample_count,
    window_start,
    window_end
FROM TUMBLE(sensors_raw, proctime(), INTERVAL '1' MINUTE)
GROUP BY sensor, site_id, window_start, window_end;
