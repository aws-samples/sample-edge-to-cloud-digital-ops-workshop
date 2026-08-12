import type { Pool } from "pg";
import type { FreshnessPayload } from "../app/api/freshness/route";

// Shared aggregate queries used by both the polled /api/freshness route and
// the two push-based /api/stream/* routes (#160) — same SQL, same freshness
// formula (Date.now() - MAX(ts_ms)), so a value reported via push always
// matches what a poll of /api/freshness would return at that instant.

interface Row {
  site_id: string;
  avg_free_cpu_pct: string | null;
  avg_free_mem_pct: string | null;
  latest_ts_ms: string;
}

function toPayload(
  rows: Row[],
  source: "risingwave" | "timescaledb",
  queryLatencyMs: number
): FreshnessPayload {
  const now = Date.now();
  const latestTs = rows.length > 0 ? Math.max(...rows.map(r => Number(r.latest_ts_ms))) : 0;
  const avgFreeCpu = rows.length > 0
    ? rows.reduce((s, r) => s + (r.avg_free_cpu_pct != null ? parseFloat(r.avg_free_cpu_pct) : 0), 0) / rows.length
    : null;
  const avgFreeMem = rows.length > 0
    ? rows.reduce((s, r) => s + (r.avg_free_mem_pct != null ? parseFloat(r.avg_free_mem_pct) : 0), 0) / rows.length
    : null;

  return {
    tierFreshness: {
      risingwave_ms: source === "risingwave" && latestTs > 0 ? now - latestTs : null,
      timescaledb_ms: source === "timescaledb" && latestTs > 0 ? now - latestTs : null,
      athena_ms: null,
      influxdb_ms: null,
    },
    // Query latency — wall-clock ms to execute this tier's read. Distinct from
    // tierFreshness (data staleness): this is the read-path cost, the metric
    // where RisingWave's pre-aggregated in-memory MV is expected to beat
    // TimescaleDB's relational scan. One tier populated per payload, mirroring
    // tierFreshness so the chart merge logic is identical.
    tierLatency: {
      risingwave_ms: source === "risingwave" ? queryLatencyMs : null,
      timescaledb_ms: source === "timescaledb" ? queryLatencyMs : null,
      athena_ms: null,
      influxdb_ms: null,
    },
    fleetResources: {
      avg_free_cpu_pct: avgFreeCpu,
      avg_free_mem_pct: avgFreeMem,
    },
    nodeAge: rows.map(r => ({
      site_id: r.site_id,
      age_seconds: (now - Number(r.latest_ts_ms)) / 1000,
    })),
    source,
    sampled_at: now,
  };
}

export async function queryRisingWaveFreshness(pool: Pool): Promise<FreshnessPayload> {
  const t0 = Date.now();
  const { rows } = await pool.query<Row>(`
    SELECT
      site_id,
      AVG(CASE WHEN sensor = 'cpu_pct'      THEN 100.0 - value END) AS avg_free_cpu_pct,
      AVG(CASE WHEN sensor = 'mem_used_pct' THEN 100.0 - value END) AS avg_free_mem_pct,
      MAX(ts_ms)                                                     AS latest_ts_ms
    FROM mv_sensor_fleet_latest
    GROUP BY site_id
    ORDER BY site_id
  `);
  return toPayload(rows, "risingwave", Date.now() - t0);
}

export async function queryTimescaleDbFreshness(pool: Pool): Promise<FreshnessPayload> {
  const t0 = Date.now();
  // Unlike RisingWave, TimescaleDB reads the RAW hypertable, not a pre-collapsed
  // MV — so the partition_time predicate is load-bearing for both the
  // query-latency comparison AND freshness correctness. Two effects:
  //
  //   • Latency: `partition_time > now() - interval` lets TimescaleDB do chunk
  //     exclusion (skip every chunk older than the window) instead of scanning
  //     the whole hypertable each poll. Measured on a live 6.9M-row table this
  //     cut the query from ~1.8s (full scan; tens of seconds under load) to
  //     ~11ms. Because freshness is sampled AFTER the query returns, the old
  //     full-scan runtime was also inflating the reported *freshness* number.
  //
  //   • Correctness: the unfiltered query aggregated in long-dead sites too
  //     (leftover sim/test nodes days stale). The window keeps only
  //     actively-reporting nodes, which is what "fleet freshness" should mean.
  //
  // NB: we deliberately do NOT filter by sensor name. The panels compute
  // free-CPU/mem from cpu_pct/mem_used_pct via CASE (null for datasets that
  // don't emit them, e.g. the frac-ops telemetry sensors), but MAX(ts_ms) must
  // see ALL sensors so freshness reflects the newest reading of any kind.
  // 15 min is generous enough that steady-state telemetry always populates it;
  // if ingestion stalls longer, the query returns no rows (freshness → null),
  // correctly surfacing "no recent data" rather than a fast-but-stale number.
  const { rows } = await pool.query<Row>(`
    SELECT
      site_id,
      AVG(CASE WHEN sensor = 'cpu_pct'      THEN 100.0 - value END) AS avg_free_cpu_pct,
      AVG(CASE WHEN sensor = 'mem_used_pct' THEN 100.0 - value END) AS avg_free_mem_pct,
      MAX(ts_ms)                                                     AS latest_ts_ms
    FROM sensor_readings
    WHERE partition_time > now() - interval '15 minutes'
    GROUP BY site_id
    ORDER BY site_id
  `);
  return toPayload(rows, "timescaledb", Date.now() - t0);
}
