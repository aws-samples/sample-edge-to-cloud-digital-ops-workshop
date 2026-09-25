import { NextRequest, NextResponse } from "next/server";

// Returned by GET /api/volume?did=<slot> — backs the dashboard's "Ingest
// Volume over time" panel (#270). Reads mv_fleet_ingest_rate
// (risingwave/ddl-cloud.sql), a 5-second-bucketed COUNT(*) of every incoming
// MSK message for the caller's deployment_id — the signal an operator
// watches climb while running simulator/frac-msk-load.py against a slot.
// Polled on an interval by the browser (bursts are minute-scale; no SSE
// needed here, unlike the push-based RisingWave/TimescaleDB freshness tiers).
export interface VolumePoint {
  window_start: number; // epoch ms, 5s-bucket floor
  msg_per_s: number;
}

export interface VolumePayload {
  points: VolumePoint[];
  source: "risingwave" | "mock";
  sampled_at: number;
}

const WINDOW_MS = 10 * 60 * 1000; // ~10 min of history, matching the client-side ring buffer (#270)
const BUCKET_MS = 5000;

// Gentle synthetic baseline (with occasional bursts) so the panel isn't flat
// when RISINGWAVE_ENDPOINT is unset (local dev, no live pipeline).
function mockPayload(): VolumePayload {
  const now = Date.now();
  const points: VolumePoint[] = [];
  const start = Math.floor((now - WINDOW_MS) / BUCKET_MS) * BUCKET_MS;
  for (let t = start; t <= now; t += BUCKET_MS) {
    const base = 8 + Math.sin(t / 45000) * 4;
    const burst = Math.sin(t / 180000) > 0.85 ? 40 : 0; // occasional simulated load spike
    points.push({ window_start: t, msg_per_s: Math.max(0, base + burst + (Math.random() - 0.5) * 3) });
  }
  return { points, source: "mock", sampled_at: now };
}

export async function GET(req: NextRequest) {
  // Same `?did=` scoping as /api/freshness — mv_fleet_ingest_rate is a shared
  // MV carrying deployment_id through from every slot (#253's pattern).
  const deploymentId = req.nextUrl.searchParams.get("did") ?? process.env.WORKSHOP_DEPLOYMENT_ID ?? "";
  const endpoint = process.env.RISINGWAVE_ENDPOINT;
  if (!endpoint) return NextResponse.json(mockPayload());

  try {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: endpoint, connectionTimeoutMillis: 5000 });
    const now = Date.now();
    const since = now - WINDOW_MS;

    const { rows } = await pool.query<{ window_start: string; msg_count: string }>(
      `
      SELECT window_start, msg_count
      FROM mv_fleet_ingest_rate
      WHERE deployment_id = $1
        AND window_start > $2::bigint
      ORDER BY window_start ASC
      `,
      [deploymentId, since]
    );
    await pool.end();

    const points: VolumePoint[] = rows.map((r) => ({
      window_start: Number(r.window_start),
      msg_per_s: Number(r.msg_count) / (BUCKET_MS / 1000),
    }));

    const payload: VolumePayload = { points, source: "risingwave", sampled_at: now };
    return NextResponse.json(payload);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
