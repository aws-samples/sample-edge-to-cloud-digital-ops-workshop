import { NextRequest, NextResponse } from "next/server";

// This route is a stub that returns mock data when RisingWave / TimescaleDB
// are not yet deployed (Sessions 1-3). In Sessions 4+, replace the mock
// with a real pg query to the deployed database endpoint.

function mockRows() {
  const now = Date.now();
  return ["ws-slot00-edge-0", "ws-slot00-edge-1", "ws-slot00-edge-2"].map(
    (name, i) => ({
      thing_name: name,
      latest_ts: now - (i + 1) * 1200,
      freshness_seconds: (i + 1) * 1.2,
    })
  );
}

export async function GET(req: NextRequest) {
  const tier = req.nextUrl.searchParams.get("tier");

  if (tier === "risingwave") {
    const rwEndpoint = process.env.RISINGWAVE_ENDPOINT;
    if (!rwEndpoint) {
      // Return mock so the UI renders something before Session 4
      return NextResponse.json({ rows: mockRows(), source: "mock" });
    }

    // Real path (Session 4+): open pg connection to RisingWave MV
    // Requires `pg` package and RISINGWAVE_ENDPOINT env var
    try {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: rwEndpoint });
      const result = await pool.query(`
        SELECT thing_name,
               EXTRACT(EPOCH FROM last_seen)::bigint * 1000 AS latest_ts,
               EXTRACT(EPOCH FROM (NOW() - last_seen)) AS freshness_seconds
        FROM fleet_disk
        ORDER BY freshness_seconds DESC
      `);
      await pool.end();
      return NextResponse.json({ rows: result.rows });
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
  }

  if (tier === "timescaledb") {
    const tsEndpoint = process.env.TIMESCALEDB_ENDPOINT;
    if (!tsEndpoint) {
      return NextResponse.json({ rows: mockRows().map(r => ({ ...r, freshness_seconds: r.freshness_seconds + 1 })), source: "mock" });
    }

    try {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: tsEndpoint });
      const result = await pool.query(`
        SELECT thing_name,
               EXTRACT(EPOCH FROM MAX(message_timestamp))::bigint * 1000 AS latest_ts,
               EXTRACT(EPOCH FROM (NOW() - MAX(message_timestamp))) AS freshness_seconds
        FROM telemetry_raw
        GROUP BY thing_name
        ORDER BY freshness_seconds DESC
      `);
      await pool.end();
      return NextResponse.json({ rows: result.rows });
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "tier param must be risingwave or timescaledb" }, { status: 400 });
}
