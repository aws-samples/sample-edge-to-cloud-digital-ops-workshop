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
  source: "risingwave" | "timescaledb"
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
  return toPayload(rows, "risingwave");
}

export async function queryTimescaleDbFreshness(pool: Pool): Promise<FreshnessPayload> {
  const { rows } = await pool.query<Row>(`
    SELECT
      site_id,
      AVG(CASE WHEN sensor = 'cpu_pct'      THEN 100.0 - value END) AS avg_free_cpu_pct,
      AVG(CASE WHEN sensor = 'mem_used_pct' THEN 100.0 - value END) AS avg_free_mem_pct,
      MAX(ts_ms)                                                     AS latest_ts_ms
    FROM sensor_readings
    GROUP BY site_id
    ORDER BY site_id
  `);
  return toPayload(rows, "timescaledb");
}
