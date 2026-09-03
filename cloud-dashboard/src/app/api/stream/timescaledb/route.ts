import { Client, Pool } from "pg";
import { NextRequest } from "next/server";
import { queryTimescaleDbFreshness } from "../../../../lib/freshness-queries";

export const dynamic = "force-dynamic";

/**
 * GET /api/stream/timescaledb?did=<deploymentId>
 *
 * Server-Sent Events push for the TimescaleDB freshness tier (#160).
 * TimescaleDB/Postgres has no subscription primitive — instead a trigger on
 * `sensor_readings` (see k8s/timescaledb-cloud-cluster.yaml,
 * notify_sensor_reading()) calls pg_notify('sensor_readings_change', ...) on
 * every INSERT statement. This route holds one long-lived connection with
 * `LISTEN sensor_readings_change` and, on notification, re-runs the same
 * aggregate query the polled /api/freshness route uses and pushes the result
 * to the browser. This replaces the 3-second setInterval poll that used to
 * drive this tier.
 *
 * #253: the notify trigger fires for INSERTs from every slot (one shared
 * hypertable) — `did` scopes each re-aggregation to the caller's own slot, so
 * a notification from another slot's ingest still wakes this connection but
 * re-reads only this slot's unaffected rows.
 *
 * #210: a notification burst (one per INSERT statement under sustained
 * ingest) used to fan out into one full aggregate query per notification
 * against a default-sized pool, saturating it within seconds — a single
 * viewer was enough to trigger connect timeouts, and a caught query error
 * used to end() the shared pool, poisoning every subsequent query for the
 * rest of the connection's life. Fixed on two sides: the trigger is now
 * FOR EACH STATEMENT (see the cluster manifests), and this route
 * single-flights + trailing-debounces the resulting queries so at most one
 * aggregate runs at a time no matter how fast notifications arrive.
 *
 * If TIMESCALEDB_ENDPOINT is unset (local dev / mock mode), falls back to
 * emitting a mock payload on a timer.
 */

const DEBOUNCE_MS = 300;

export async function GET(req: NextRequest): Promise<Response> {
  const deploymentId = req.nextUrl.searchParams.get("did") ?? process.env.WORKSHOP_DEPLOYMENT_ID ?? "";
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      closed = true;
      onCancel?.();
    },
  });

  let onCancel: (() => void) | undefined;

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
          tierFreshness: { risingwave_ms: null, timescaledb_ms: 1500 + Math.random() * 800, athena_ms: null, influxdb_ms: null, appsync_ms: null },
          tierLatency: { risingwave_ms: null, timescaledb_ms: 15 + Math.random() * 20, athena_ms: null, influxdb_ms: null, appsync_ms: null },
          deviceHopLatency: { risingwave_ms: null, timescaledb_ms: null, athena_ms: null, influxdb_ms: null, appsync_ms: null },
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

  // One long-lived pool for the lifetime of this SSE connection. Never end()
  // it on a transient query error (#210) — only in the finally block below,
  // after the LISTEN client has been torn down. A small explicit `max` caps
  // worst-case connection usage per viewer regardless of notification rate.
  const pool = new Pool({ connectionString: endpoint, connectionTimeoutMillis: 5000, max: 5 });
  pool.on("error", err => {
    // Fires for errors on idle pooled clients (e.g. a killed backend) — must
    // be handled or it crashes the process. The pool itself stays usable.
    console.error("[stream/timescaledb] pool error:", err);
  });

  const client = new Client({ connectionString: endpoint, connectionTimeoutMillis: 5000 });

  // Single-flight + trailing debounce (#210): collapse a burst of
  // notifications into at most one in-flight aggregate query. If more
  // notifications arrive while a query is running, run exactly one more
  // when it completes rather than one per notification.
  let inFlight = false;
  let queuedWhileInFlight = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  async function runAggregate() {
    if (inFlight) {
      queuedWhileInFlight = true;
      return;
    }
    inFlight = true;
    try {
      const payload = await queryTimescaleDbFreshness(pool, deploymentId);
      send("freshness", payload);
    } catch (err) {
      console.error("[stream/timescaledb] query error:", err);
      send("tier-error", { message: String(err instanceof Error ? err.message : err) });
    } finally {
      inFlight = false;
      if (queuedWhileInFlight) {
        queuedWhileInFlight = false;
        void runAggregate();
      }
    }
  }

  function scheduleAggregate() {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runAggregate();
    }, DEBOUNCE_MS);
  }

  onCancel = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  (async () => {
    try {
      await client.connect();

      client.on("notification", scheduleAggregate);

      client.on("error", err => {
        console.error("[stream/timescaledb] connection error:", err);
        send("tier-error", { message: String(err instanceof Error ? err.message : err) });
      });

      await client.query("LISTEN sensor_readings_change");
      sendComment("connected");

      // Send an initial snapshot immediately so the chart has data before the
      // first notification arrives.
      await runAggregate();

      // Keep the connection open — notifications arrive asynchronously via
      // the 'notification' event above. Poll for browser disconnect instead
      // of blocking on a query.
      while (!closed) {
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (err) {
      console.error("[stream/timescaledb] error:", err);
      send("tier-error", { message: String(err instanceof Error ? err.message : err) });
      sendComment(`error: ${String(err)}`);
      try {
        controller.close();
      } catch {
        // already closed
      }
    } finally {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      try {
        await client.end();
      } catch {
        // ignore — connection may already be down
      }
      try {
        await pool.end();
      } catch {
        // ignore — pool may already be shutting down
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
