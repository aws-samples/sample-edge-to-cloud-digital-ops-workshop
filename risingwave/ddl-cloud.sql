-- RisingWave DDL — cloud EKS instance
--
-- Applied automatically by the post-install/post-upgrade Job in
-- helm/cloud-analytics/templates/risingwave-ddl-job.yaml (mirrors the pattern
-- in helm/edge-stack/templates/risingwave-ddl-job.yaml) — the Job reads the
-- __MSK_BOOTSTRAP__/__MSK_USER__/__MSK_PASS__ placeholders below from the
-- in-cluster `msk-credentials` Secret, substitutes them itself, then pipes
-- the result through psql. No manual sed/psql step (see #159).
--
-- #207: `CREATE ... IF NOT EXISTS` alone only guards against a re-run erroring
-- on an already-existing NAME — it does NOT re-apply a changed DEFINITION, so
-- on a slot where these objects were already created by an earlier version of
-- this file, a `helm upgrade` carrying updated SQL silently no-ops forever.
-- Confirmed live on ws-slot90: `sensors_raw_telemetry` still had its pre-#195
-- column list (no `deployment_id`) and `mv_sensor_fleet_latest` still read
-- straight off the unscoped sources, despite both having been fixed on `main`
-- for hours. Every object below is now DROPped (reverse dependency order)
-- immediately before being recreated, so a definition/schema change here
-- always reaches an already-provisioned slot on its next upgrade, not just a
-- fresh one.
--
-- To re-apply by hand for debugging, port-forward the frontend service and
-- substitute the same placeholders yourself:
--   kubectl port-forward -n cloud-analytics svc/risingwave-cloud-frontend 4567:4567
--
-- #253 — SHARED instance, filtered by deployment_id (not per-slot anymore):
--   cloud-analytics used to be deployed once PER SLOT, each filtered down to
--   its own slot's rows (the `sim_this_slot` / `telemetry_this_slot` views,
--   WHERE-filtered on a per-slot placeholder substituted from
--   `.Values.deploymentId`). That hit a hard EKS capacity ceiling — every slot
--   added a full RisingWave+TimescaleDB+dashboard stack. cloud-analytics is
--   now ONE shared release for every slot: the two views below no longer
--   filter anything, they only CARRY `deployment_id` through (sim rows derive
--   it from the `^ws-slot[0-9]+` prefix of `site_id`; device rows already
--   have it as a column, stamped by the IoT rule — see
--   amplify/custom/participant-stack.ts). Every MV downstream promotes
--   `deployment_id` into its SELECT list and GROUP BY, so one shared instance
--   still reports separate numbers per slot — the dashboard/API layer
--   (cloud-dashboard, frontend) filters reads to the caller's slot via
--   `?did=`.
--
--   scan.startup.mode stays 'latest' (NOT 'earliest'): 'earliest' would replay
--   the entire shared-topic history (observed ~7.5M rows) on every source
--   restart — the exact startup-backfill memory spike that caused the compute
--   OOM fixed in PR #191.

-- ─────────────────────────────────────────────────────────────────────────────
-- #207: drop every object this file (re)creates, in reverse dependency order,
-- before recreating any of them below.
--
-- The pg_sleep after DROP SUBSCRIPTION is load-bearing, confirmed live: a
-- subscription's teardown (its underlying streaming job) is asynchronous —
-- DROP SUBSCRIPTION returns success immediately, but a subsequent DROP
-- MATERIALIZED VIEW on the relation it read from can still fail with "table
-- used by 1 other objects" for a few seconds afterward, until that teardown
-- actually completes. Nothing else here tears down a streaming job on drop,
-- so no further delay is needed.
-- ─────────────────────────────────────────────────────────────────────────────
DROP SUBSCRIPTION IF EXISTS dashboard_freshness_sub;
SELECT pg_sleep(5);
DROP MATERIALIZED VIEW IF EXISTS mv_fleet_1min_avg;
DROP MATERIALIZED VIEW IF EXISTS mv_sensor_fleet_latest;
DROP MATERIALIZED VIEW IF EXISTS mv_device_hop_latency;
DROP VIEW IF EXISTS telemetry_all_slots;
DROP VIEW IF EXISTS sim_all_slots;
DROP SOURCE IF EXISTS sensors_raw_telemetry;
DROP SOURCE IF EXISTS sensors_raw_cloud;

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
    deployment_id      VARCHAR,
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
-- #253: fleet-wide views (plain CREATE VIEW — no extra streaming state or
-- memory footprint) that carry `deployment_id` through from each source,
-- WITHOUT filtering to any one slot — the shared instance serves every slot
-- from these same two sources.
--   - sim rows: derive deployment_id from the `^ws-slot[0-9]+` prefix of
--     site_id (SITE_ID env on the sensor-sim EC2 is `${deploymentId}-sim`).
--   - device rows: deployment_id is already a column (the IoT→MSK rule
--     stamps `'<deploymentId>' AS deployment_id`).
-- The MVs below select from these views, never from the raw sources directly,
-- so deployment_id derivation is enforced in exactly one place.
-- ─────────────────────────────────────────────────────────────────────────────
-- deployment_id is the `^ws-slot[0-9]+` prefix of site_id. Use regexp_match, NOT
-- the SQL-standard `substring(x FROM pattern)` POSIX form: RisingWave does not
-- support the pattern form of substring — it reads the second argument as an
-- integer start position and fails at runtime with `str_parse('^ws-slot...')` /
-- "integer invalid digit found in string", which broke the whole DDL hook job.
-- CI never catches this because the DDL is only ever applied against a live
-- RisingWave, not in CI. regexp_match returns a varchar[]; element [1] is the
-- whole match (no capture group needed).
CREATE VIEW IF NOT EXISTS sim_all_slots AS
SELECT sensor, site_id, value, unit, ts_ms,
       (regexp_match(site_id, '^ws-slot[0-9]+'))[1] AS deployment_id
FROM sensors_raw_cloud;

CREATE VIEW IF NOT EXISTS telemetry_all_slots AS
SELECT thing_name, deployment_id, cpu_pct, mem_used_pct, disk_used_pct,
       net_io_bytes_sent, net_io_bytes_recv, message_timestamp, ingest_ts
FROM sensors_raw_telemetry;

-- ─────────────────────────────────────────────────────────────────────────────
-- Materialized view: latest reading per sensor per site across the entire fleet.
-- Unions industrial sensor data (sensors_raw_cloud) with IoT node telemetry
-- (sensors_raw_telemetry unpivoted into per-metric rows). deployment_id is
-- carried into the SELECT list and GROUP BY (#253) so one shared MV still
-- reports a distinct row per (sensor, site_id) *per slot*.
-- Uses array_agg ORDER BY to pick the value with the highest ts_ms.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_sensor_fleet_latest AS
SELECT
    sensor,
    site_id,
    deployment_id,
    (array_agg(value ORDER BY ts_ms DESC))[1]  AS value,
    (array_agg(unit  ORDER BY ts_ms DESC))[1]  AS unit,
    MAX(ts_ms)                                  AS ts_ms
FROM (
    SELECT sensor, site_id, value, unit, ts_ms, deployment_id FROM sim_all_slots
    UNION ALL
    SELECT 'cpu_pct'           AS sensor, thing_name AS site_id, cpu_pct                    AS value, 'percent' AS unit, ingest_ts AS ts_ms, deployment_id FROM telemetry_all_slots
    UNION ALL
    SELECT 'mem_used_pct'      AS sensor, thing_name AS site_id, mem_used_pct               AS value, 'percent' AS unit, ingest_ts AS ts_ms, deployment_id FROM telemetry_all_slots
    UNION ALL
    SELECT 'disk_used_pct'     AS sensor, thing_name AS site_id, disk_used_pct              AS value, 'percent' AS unit, ingest_ts AS ts_ms, deployment_id FROM telemetry_all_slots
    UNION ALL
    SELECT 'net_io_bytes_sent' AS sensor, thing_name AS site_id, net_io_bytes_sent::DOUBLE  AS value, 'bytes'   AS unit, ingest_ts AS ts_ms, deployment_id FROM telemetry_all_slots
    UNION ALL
    SELECT 'net_io_bytes_recv' AS sensor, thing_name AS site_id, net_io_bytes_recv::DOUBLE  AS value, 'bytes'   AS unit, ingest_ts AS ts_ms, deployment_id FROM telemetry_all_slots
) combined
GROUP BY sensor, site_id, deployment_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- Materialized view: 1-minute tumbling window averages per sensor per site.
-- Buckets by (ts_ms / 60000) integer division — no watermark required.
-- deployment_id carried into SELECT + GROUP BY (#253).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_fleet_1min_avg AS
SELECT
    sensor,
    site_id,
    deployment_id,
    AVG(value)                                            AS avg_value,
    MIN(value)                                            AS min_value,
    MAX(value)                                            AS max_value,
    COUNT(*)                                              AS sample_count,
    to_timestamp((ts_ms / 60000) * 60)                   AS window_start,
    to_timestamp((ts_ms / 60000) * 60 + 60)              AS window_end
FROM (
    SELECT sensor, site_id, value, ts_ms, deployment_id FROM sim_all_slots
    UNION ALL
    SELECT 'cpu_pct'           AS sensor, thing_name AS site_id, cpu_pct                   AS value, ingest_ts AS ts_ms, deployment_id FROM telemetry_all_slots
    UNION ALL
    SELECT 'mem_used_pct'      AS sensor, thing_name AS site_id, mem_used_pct              AS value, ingest_ts AS ts_ms, deployment_id FROM telemetry_all_slots
    UNION ALL
    SELECT 'disk_used_pct'     AS sensor, thing_name AS site_id, disk_used_pct             AS value, ingest_ts AS ts_ms, deployment_id FROM telemetry_all_slots
    UNION ALL
    SELECT 'net_io_bytes_sent' AS sensor, thing_name AS site_id, net_io_bytes_sent::DOUBLE AS value, ingest_ts AS ts_ms, deployment_id FROM telemetry_all_slots
    UNION ALL
    SELECT 'net_io_bytes_recv' AS sensor, thing_name AS site_id, net_io_bytes_recv::DOUBLE AS value, ingest_ts AS ts_ms, deployment_id FROM telemetry_all_slots
) combined
GROUP BY sensor, site_id, deployment_id, (ts_ms / 60000);

-- ─────────────────────────────────────────────────────────────────────────────
-- Materialized view: device→ingest hop latency (#245). ingest_ts is stamped by
-- the IoT Rule on arrival; message_timestamp is stamped by the device
-- immediately before publish (see job-scripts/telemetry-v*.sh). The delta is
-- the device-side MQTT publish + network hop -- upstream of any data store,
-- and currently the dominant segment of the sensor→dashboard budget (#246).
-- Bounded to a recent window (temporal filter, mirrors the TSDB 15-min
-- freshness window in cloud-dashboard/src/lib/freshness-queries.ts) so the
-- number reflects current behaviour rather than a lifetime average, and so
-- this MV's state stays bounded. Grouped by deployment_id (#253) so the
-- shared instance reports one hop-latency number per slot, not one fleet-wide
-- average across every slot's devices. Degrades to NULL (not an error) when no
-- row in a slot's window carries message_timestamp -- e.g. older payloads or a
-- sim-only slot with no device telemetry.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_device_hop_latency AS
SELECT
    deployment_id,
    AVG(ingest_ts - message_timestamp) AS avg_device_hop_ms,
    COUNT(*)                            AS sample_count
FROM telemetry_all_slots
WHERE message_timestamp IS NOT NULL
  AND to_timestamp(ingest_ts / 1000) > now() - INTERVAL '15' MINUTE
GROUP BY deployment_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- Subscription: change feed on mv_sensor_fleet_latest for the cloud dashboard's
-- push path (#160). A server-side consumer (cloud-dashboard's
-- /api/stream/risingwave route) declares a SUBSCRIPTION CURSOR against this
-- and relays each change event to the browser over SSE — no client polling.
-- Every slot shares this one subscription; each connected browser's route
-- re-aggregates mv_sensor_fleet_latest filtered to its own `?did=` on every
-- change event, so a change to slot A's rows doesn't push stale-looking data
-- to slot B's viewers, it just wakes them to re-read their own, unaffected rows.
-- Retention window bounds how far a newly-connected cursor can look back.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE SUBSCRIPTION IF NOT EXISTS dashboard_freshness_sub
FROM mv_sensor_fleet_latest
WITH (retention = '1D');
