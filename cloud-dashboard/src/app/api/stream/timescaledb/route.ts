import { Client } from "pg";
import { queryTimescaleDbFreshness } from "../../../../lib/freshness-queries";

export const dynamic = "force-dynamic";

/**
 * GET /api/stream/timescaledb
 *
 * Server-Sent Events push for the TimescaleDB freshness tier (#160).
 * TimescaleDB/Postgres has no subscription primitive — instead a trigger on
 * `sensor_readings` (see k8s/timescaledb-cloud-cluster.yaml,
 * notify_sensor_reading()) calls pg_notify('sensor_readings_change', ...) on
 * every insert. This route holds one long-lived connection with
 * `LISTEN sensor_readings_change` and, on each notification, re-runs the same
 * aggregate query the polled /api/freshness route uses and pushes the result
 * to the browser. This replaces the 3-second setInterval poll that used to
 * drive this tier.
 *
 * If TIMESCALEDB_ENDPOINT is unset (local dev / mock mode), falls back to
 * emitting a mock payload on a timer.
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

  const endpoint = process.env.TIMESCALEDB_ENDPOINT;

  if (!endpoint) {
    (async () => {
      sendComment("connected (mock)");
      while (!closed) {
        const now = Date.now();
        send("freshness", {
          tierFreshness: { risingwave_ms: null, timescaledb_ms: 1500 + Math.random() * 800, athena_ms: null },
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

      // Fan out every notification into a fresh aggregate query — see the
      // module doc comment above for why we re-query instead of trusting the
      // notification payload directly (it carries one row, the chart needs a
      // fleet-wide aggregate).
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: endpoint, connectionTimeoutMillis: 5000 });

      client.on("notification", () => {
        queryTimescaleDbFreshness(pool)
          .then(payload => send("freshness", payload))
          .catch(err => console.error("[stream/timescaledb] query error:", err));
      });

      client.on("error", err => {
        console.error("[stream/timescaledb] connection error:", err);
      });

      await client.query("LISTEN sensor_readings_change");
      sendComment("connected");

      // Send an initial snapshot immediately so the chart has data before the
      // first notification arrives.
      send("freshness", await queryTimescaleDbFreshness(pool));

      // Keep the connection open — notifications arrive asynchronously via
      // the 'notification' event above. Poll for browser disconnect instead
      // of blocking on a query.
      while (!closed) {
        await new Promise(r => setTimeout(r, 1000));
      }

      await pool.end();
    } catch (err) {
      console.error("[stream/timescaledb] error:", err);
      sendComment(`error: ${String(err)}`);
      try {
        controller.close();
      } catch {
        // already closed
      }
    } finally {
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
      "X-Accel-Buffering": "no",
    },
  });
}
