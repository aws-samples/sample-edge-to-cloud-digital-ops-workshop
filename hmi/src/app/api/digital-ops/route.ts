// --8<-- [start:digital-ops-route]
import { Pool } from "pg";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

let pool: Pool | null = null;
function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: process.env.TIMESCALE_HOST ?? "timescaledb-rw",
      port: parseInt(process.env.TIMESCALE_PORT ?? "5432", 10),
      database: process.env.TIMESCALE_DB ?? "edge",
      user: process.env.TIMESCALE_USER ?? "workshop",
      password: process.env.TIMESCALE_PASSWORD ?? "workshop",
      ssl: false,
      max: 4,
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

export interface SensorStats {
  sensor: string;
  avg: number | null;
  min: number | null;
  max: number | null;
  count: number;
}

/**
 * GET /api/digital-ops
 *
 * Returns per-sensor statistics for the last 5 minutes, queried directly
 * from TimescaleDB.
 *
 * Response shape:
 * {
 *   stats: SensorStats[];
 *   queryDurationMs: number;
 * }
 */
export async function GET(): Promise<NextResponse> {
  const t0 = Date.now();

  try {
    const result = await getPool().query<
      SensorStats & { avg: string; min: string; max: string; count: string }
    >(`
      SELECT
        sensor,
        AVG(value)::float8   AS avg,
        MIN(value)::float8   AS min,
        MAX(value)::float8   AS max,
        COUNT(*)::int        AS count
      FROM sensor_readings
      WHERE partition_time >= NOW() - INTERVAL '5 minutes'
      GROUP BY sensor
      ORDER BY sensor
    `);

    const stats: SensorStats[] = result.rows.map((r) => ({
      sensor: r.sensor,
      avg: r.avg != null ? parseFloat(String(r.avg)) : null,
      min: r.min != null ? parseFloat(String(r.min)) : null,
      max: r.max != null ? parseFloat(String(r.max)) : null,
      count: parseInt(String(r.count), 10),
    }));

    return NextResponse.json(
      { stats, queryDurationMs: Date.now() - t0 },
      { status: 200 }
    );
  } catch (err) {
    console.error("[digital-ops] query error:", err);
    return NextResponse.json(
      { error: String(err), stats: [], queryDurationMs: Date.now() - t0 },
      { status: 500 }
    );
  }
}
// --8<-- [end:digital-ops-route]
