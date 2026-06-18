import { NextRequest, NextResponse } from "next/server";

// Returned by GET /api/freshness?tier=risingwave|timescaledb
// Contains all three chart datasets in one call.
export interface FreshnessPayload {
  // Chart 1 — data freshness per tier (single numbers, ms)
  tierFreshness: {
    risingwave_ms: number | null;
    timescaledb_ms: number | null;
    athena_ms: number | null; // static / not queried here — kept for chart completeness
  };
  // Chart 2 — fleet-wide free CPU and memory (percentage)
  fleetResources: {
    avg_free_cpu_pct: number | null;
    avg_free_mem_pct: number | null;
  };
  // Chart 3 — per-node time since last message (seconds)
  nodeAge: Array<{ site_id: string; age_seconds: number }>;
  source: "risingwave" | "timescaledb" | "mock";
  sampled_at: number; // epoch ms on server
}

function mockPayload(source: "risingwave" | "timescaledb" | "mock"): FreshnessPayload {
  const now = Date.now();
  const rw_ms = source === "risingwave" ? 350 + Math.random() * 200 : null;
  const ts_ms = source === "timescaledb" ? 1500 + Math.random() * 800 : null;
  return {
    tierFreshness: {
      risingwave_ms: rw_ms,
      timescaledb_ms: ts_ms,
      athena_ms: 28000 + Math.random() * 5000,
    },
    fleetResources: {
      avg_free_cpu_pct: 85 + Math.random() * 10,
      avg_free_mem_pct: 60 + Math.random() * 10,
    },
    nodeAge: ["ws-slot00-edge-0", "ws-slot00-edge-1", "ws-slot00-edge-2"].map(
      (id, i) => ({ site_id: id, age_seconds: (i + 1) * 1.2 + Math.random() * 0.5 })
    ),
    source,
    sampled_at: now,
  };
}

export async function GET(req: NextRequest) {
  const tier = req.nextUrl.searchParams.get("tier") as "risingwave" | "timescaledb" | null;

  if (tier === "risingwave") {
    const endpoint = process.env.RISINGWAVE_ENDPOINT;
    if (!endpoint) return NextResponse.json(mockPayload("risingwave"));

    try {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: endpoint, connectionTimeoutMillis: 5000 });
      const now = Date.now();

      // All three datasets from mv_sensor_fleet_latest in one query
      const { rows } = await pool.query<{
        site_id: string;
        avg_free_cpu_pct: string | null;
        avg_free_mem_pct: string | null;
        latest_ts_ms: string;
      }>(`
        SELECT
          site_id,
          AVG(CASE WHEN sensor = 'cpu_pct'      THEN 100.0 - value END) AS avg_free_cpu_pct,
          AVG(CASE WHEN sensor = 'mem_used_pct' THEN 100.0 - value END) AS avg_free_mem_pct,
          MAX(ts_ms)                                                     AS latest_ts_ms
        FROM mv_sensor_fleet_latest
        GROUP BY site_id
        ORDER BY site_id
      `);
      await pool.end();

      const latestTs = rows.length > 0 ? Math.max(...rows.map(r => Number(r.latest_ts_ms))) : 0;
      const avgFreeCpu = rows.length > 0
        ? rows.reduce((s, r) => s + (r.avg_free_cpu_pct != null ? parseFloat(r.avg_free_cpu_pct) : 0), 0) / rows.length
        : null;
      const avgFreeMem = rows.length > 0
        ? rows.reduce((s, r) => s + (r.avg_free_mem_pct != null ? parseFloat(r.avg_free_mem_pct) : 0), 0) / rows.length
        : null;

      const payload: FreshnessPayload = {
        tierFreshness: {
          risingwave_ms: latestTs > 0 ? now - latestTs : null,
          timescaledb_ms: null,
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
        source: "risingwave",
        sampled_at: now,
      };
      return NextResponse.json(payload);
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
  }

  if (tier === "timescaledb") {
    const endpoint = process.env.TIMESCALEDB_ENDPOINT;
    if (!endpoint) return NextResponse.json(mockPayload("timescaledb"));

    try {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: endpoint, connectionTimeoutMillis: 5000 });
      const now = Date.now();

      const { rows } = await pool.query<{
        site_id: string;
        avg_free_cpu_pct: string | null;
        avg_free_mem_pct: string | null;
        latest_ts_ms: string;
      }>(`
        SELECT
          site_id,
          AVG(CASE WHEN sensor = 'cpu_pct'      THEN 100.0 - value END) AS avg_free_cpu_pct,
          AVG(CASE WHEN sensor = 'mem_used_pct' THEN 100.0 - value END) AS avg_free_mem_pct,
          MAX(ts_ms)                                                     AS latest_ts_ms
        FROM sensor_readings
        GROUP BY site_id
        ORDER BY site_id
      `);
      await pool.end();

      const latestTs = rows.length > 0 ? Math.max(...rows.map(r => Number(r.latest_ts_ms))) : 0;
      const avgFreeCpu = rows.length > 0
        ? rows.reduce((s, r) => s + (r.avg_free_cpu_pct != null ? parseFloat(r.avg_free_cpu_pct) : 0), 0) / rows.length
        : null;
      const avgFreeMem = rows.length > 0
        ? rows.reduce((s, r) => s + (r.avg_free_mem_pct != null ? parseFloat(r.avg_free_mem_pct) : 0), 0) / rows.length
        : null;

      const payload: FreshnessPayload = {
        tierFreshness: {
          risingwave_ms: null,
          timescaledb_ms: latestTs > 0 ? now - latestTs : null,
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
        source: "timescaledb",
        sampled_at: now,
      };
      return NextResponse.json(payload);
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "tier param must be risingwave or timescaledb" }, { status: 400 });
}
