import { Client } from "pg";
import { queryRisingWaveFreshness } from "../../../../lib/freshness-queries";

export const dynamic = "force-dynamic";

/**
 * GET /api/stream/risingwave
 *
 * Server-Sent Events push for the RisingWave freshness tier (#160). Opens a
 * single long-lived pg connection, uses RisingWave's native subscription
 * cursor (CREATE SUBSCRIPTION + DECLARE ... SUBSCRIPTION CURSOR + FETCH) on
 * mv_sensor_fleet_latest, and on every change event re-runs the same
 * aggregate query the polled /api/freshness route uses, then pushes the
 * resulting FreshnessPayload to the browser as a "freshness" SSE event. This
 * replaces the 3-second setInterval poll that used to drive this tier.
 *
 * If RISINGWAVE_ENDPOINT is unset (local dev / mock mode), falls back to
 * emitting a mock payload on a timer so the frontend still has something to
 * render — this is the one place a timer remains, and only when there is no
 * real subscription to attach to.
 */
export async function GET(): Promise<Response> {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      closed = true;
    },
  });

  const encoder = new TextEncoder();

  function send(event: string, data: unknown) {
    if (closed) return;
    try {
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      closed = true;
    }
  }

  function sendComment(msg: string) {
    if (closed) return;
    try {
      controller.enqueue(encoder.encode(`: ${msg}\n\n`));
    } catch {
      closed = true;
    }
  }

  const endpoint = process.env.RISINGWAVE_ENDPOINT;

  if (!endpoint) {
    (async () => {
      sendComment("connected (mock)");
      while (!closed) {
        const now = Date.now();
        send("freshness", {
          tierFreshness: { risingwave_ms: 350 + Math.random() * 200, timescaledb_ms: null, athena_ms: null },
          tierLatency: { risingwave_ms: 3 + Math.random() * 5, timescaledb_ms: null, athena_ms: null },
          fleetResources: { avg_free_cpu_pct: 85 + Math.random() * 10, avg_free_mem_pct: 60 + Math.random() * 10 },
          nodeAge: ["ws-slot00-edge-0", "ws-slot00-edge-1", "ws-slot00-edge-2"].map((id, i) => ({
            site_id: id,
            age_seconds: (i + 1) * 1.2 + Math.random() * 0.5,
          })),
          source: "mock",
          sampled_at: now,
        });
        await new Promise(r => setTimeout(r, 3000));
      }
    })();
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  const client = new Client({ connectionString: endpoint, connectionTimeoutMillis: 5000 });

  (async () => {
    try {
      await client.connect();

      // RisingWave subscription cursor pattern (v2.0+):
      //   1. CREATE SUBSCRIPTION (idempotent — skips if already exists)
      //   2. DECLARE SUBSCRIPTION CURSOR — starts from current position
      //   3. FETCH n FROM cursor — poll for new change rows
      // We don't forward the raw change rows to the browser — mv_sensor_fleet_latest
      // stores one row per (sensor, site_id), so a single insert/update only tells us
      // one metric changed. Instead each change event triggers a re-run of the same
      // fleet-wide aggregate the polled endpoint uses, so the two never disagree.
      const subName = "dashboard_freshness_sub";
      const curName = "dashboard_freshness_cur";
      await client.query(
        `CREATE SUBSCRIPTION IF NOT EXISTS ${subName} FROM mv_sensor_fleet_latest WITH (retention = '1D')`
      );
      // Drop cursor first — it may persist from a prior connection on the same
      // RisingWave instance, and DECLARE fails if the cursor name already exists.
      await client.query(`CLOSE ${curName}`).catch(() => {});
      await client.query(`DECLARE ${curName} SUBSCRIPTION CURSOR FOR ${subName}`);

      sendComment("connected");

      // Send an initial snapshot immediately so the chart has data before the
      // first change event arrives.
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: endpoint, connectionTimeoutMillis: 5000 });
      send("freshness", await queryRisingWaveFreshness(pool));

      while (!closed) {
        const result = await client.query(`FETCH 100 FROM ${curName}`);

        if (result.rows.length > 0) {
          send("freshness", await queryRisingWaveFreshness(pool));
        }

        // Brief pause to avoid hammering the DB when no new data arrives.
        await new Promise(r => setTimeout(r, 100));
      }

      await pool.end();
    } catch (err) {
      console.error("[stream/risingwave] error:", err);
      sendComment(`error: ${String(err)}`);
      try {
        controller.close();
      } catch {
        // already closed
      }
    } finally {
      try {
        await client.query("CLOSE dashboard_freshness_cur");
      } catch {
        // cursor may already be gone
      }
      try {
        await client.end();
      } catch {
        // ignore
      }
    }
  })();

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // tell nginx/ALB not to buffer SSE
    },
  });
}
