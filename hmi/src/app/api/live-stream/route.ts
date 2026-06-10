// --8<-- [start:live-stream-route]
import { Client } from "pg";

export const dynamic = "force-dynamic";

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

  const RW_HOST = process.env.RISINGWAVE_HOST ?? "edge-risingwave";
  const RW_PORT = parseInt(process.env.RISINGWAVE_PORT ?? "4567", 10);

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

      // RisingWave subscription cursor pattern (v2.0+):
      //   1. CREATE SUBSCRIPTION (idempotent — skips if already exists)
      //   2. DECLARE SUBSCRIPTION CURSOR — starts from current position
      //   3. FETCH n FROM cursor — poll for new change rows
      // Each row has: op (1=insert/upsert, 2=delete/retract), plus MV columns.
      const subName = "hmi_live_stream";
      const curName = "hmi_cursor";
      await client.query(
        `CREATE SUBSCRIPTION IF NOT EXISTS ${subName} FROM mv_sensor_latest WITH (retention = '1D')`
      );
      await client.query(
        `DECLARE ${curName} SUBSCRIPTION CURSOR FOR ${subName}`
      );

      sendComment("connected");

      while (true) {
        const result = await client.query(`FETCH 100 FROM ${curName}`);

        for (const row of result.rows) {
          // row: { op, ts_ms, sensor, site_id, value, unit }
          // RisingWave 2.8+ returns op as "Insert"/"Delete" string (older: 1/2 int).
          // Skip deletes/retracts; forward inserts/upserts.
          const opStr = String(row.op ?? "Insert");
          if (opStr === "Delete" || opStr === "2") continue;

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
        await client.query("CLOSE hmi_cursor");
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
      "X-Accel-Buffering": "no", // tell nginx not to buffer SSE
    },
  });
}
// --8<-- [end:live-stream-route]
