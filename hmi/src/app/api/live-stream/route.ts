// --8<-- [start:live-stream-route]
import { Client } from "pg";

const RW_HOST = process.env.RISINGWAVE_HOST ?? "edge-risingwave";
const RW_PORT = parseInt(process.env.RISINGWAVE_PORT ?? "4566", 10);

/**
 * GET /api/live-stream
 *
 * Opens a Server-Sent Events stream. Each event is named "sensor" and
 * carries a JSON payload: { sensor, site_id, value, unit, ts_ms }.
 *
 * Uses RisingWave's SUBSCRIBE syntax over the standard PostgreSQL wire
 * protocol. The cursor is polled in a tight loop (100 ms sleep) so that
 * new rows are forwarded to the browser as soon as they appear in the
 * materialized view.
 */
export async function GET(): Promise<Response> {
  let controller!: ReadableStreamDefaultController<Uint8Array>;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      // browser disconnected — the cleanup block below handles the pg client
    },
  });

  const encoder = new TextEncoder();

  function send(event: string, data: string) {
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
  }

  function sendComment(msg: string) {
    controller.enqueue(encoder.encode(`: ${msg}\n\n`));
  }

  const client = new Client({
    host: RW_HOST,
    port: RW_PORT,
    database: "dev",
    user: "root",
    password: "",
    ssl: false,
  });

  (async () => {
    try {
      await client.connect();

      // RisingWave SUBSCRIBE — streams change rows from the materialized view.
      // initial_checkpoint = false means we only see NEW changes, not the
      // entire current snapshot.
      await client.query(
        "SUBSCRIBE mv_sensor_latest WITH (initial_checkpoint = false)"
      );

      sendComment("connected");

      // FETCH NEXT returns 0 or more rows each call.
      // We loop until the client disconnects (stream is cancelled).
      while (true) {
        const result = await client.query("FETCH NEXT FROM mv_sensor_latest");

        for (const row of result.rows) {
          // row: { op, ts_ms, sensor, site_id, value, unit }
          // op = 1 (insert/upsert). Skip deletes/retracts (op = 2).
          if (row.op !== undefined && row.op !== 1) continue;

          send(
            "sensor",
            JSON.stringify({
              sensor: row.sensor,
              site_id: row.site_id,
              value: parseFloat(row.value),
              unit: row.unit,
              ts_ms: row.ts_ms,
            })
          );
        }

        // Brief pause to avoid hammering the DB when no new data arrives
        await new Promise((r) => setTimeout(r, 100));
      }
    } catch (err) {
      console.error("[live-stream] error:", err);
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
      "X-Accel-Buffering": "no", // tell nginx not to buffer SSE
    },
  });
}
// --8<-- [end:live-stream-route]
