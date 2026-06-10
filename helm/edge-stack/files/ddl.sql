-- RisingWave DDL — run once after Helm deploy, before starting the HMI
-- Connect: psql -h localhost -p 4567 -U root
-- (after: kubectl port-forward -n edge svc/edge-stack-risingwave 4567:4567)
--
-- Note: RisingWave's PostgreSQL wire protocol is on port 4567.
-- Port 4566 is the HTTP dashboard (not the Postgres wire protocol).
-- Port 4560 is the internal meta/compute service port.

-- Source: raw sensor messages from local Redpanda cluster.
-- Redpanda Connect (ingest) writes JSON to topics sensors.raw.<sensor_name>.
CREATE SOURCE IF NOT EXISTS sensors_raw (
    sensor    VARCHAR,
    site_id   VARCHAR,
    value     DOUBLE,
    unit      VARCHAR,
    ts_ms     BIGINT
)
WITH (
    connector                   = 'kafka',
    topic                       = 'sensors.raw.sim',
    properties.bootstrap.server = 'edge-stack-0.edge-stack.edge.svc.cluster.local:9093',
    scan.startup.mode           = 'latest'
)
FORMAT PLAIN ENCODE JSON;

-- Latest reading per sensor per site.
-- Uses array_agg ORDER BY (MAX_BY is not available in v2.8.x).
-- HMI /api/live-stream subscribes to this view.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_sensor_latest AS
SELECT
    sensor,
    site_id,
    (array_agg(value ORDER BY ts_ms DESC))[1]  AS value,
    (array_agg(unit  ORDER BY ts_ms DESC))[1]  AS unit,
    MAX(ts_ms)                                  AS ts_ms
FROM sensors_raw
GROUP BY sensor, site_id;

-- 1-minute bucket averages (used by Digital Ops page).
-- Uses integer epoch-bucketing instead of TUMBLE(proctime()) which requires watermarks.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_sensor_1min_avg AS
SELECT
    sensor,
    site_id,
    AVG(value)                                            AS avg_value,
    MIN(value)                                            AS min_value,
    MAX(value)                                            AS max_value,
    COUNT(*)                                              AS sample_count,
    to_timestamp((ts_ms / 60000) * 60)                   AS window_start,
    to_timestamp((ts_ms / 60000) * 60 + 60)              AS window_end
FROM sensors_raw
GROUP BY sensor, site_id, (ts_ms / 60000);
