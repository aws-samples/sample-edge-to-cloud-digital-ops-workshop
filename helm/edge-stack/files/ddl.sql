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

-- Materialized view: latest reading per sensor per site.
-- Uses MAX_BY to get the value/unit from the row with the highest ts_ms.
-- HMI /api/live-stream subscribes to this view.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_sensor_latest AS
SELECT
    sensor,
    site_id,
    MAX_BY(value, ts_ms)  AS value,
    MAX_BY(unit,  ts_ms)  AS unit,
    MAX(ts_ms)            AS ts_ms
FROM sensors_raw
GROUP BY sensor, site_id;

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
