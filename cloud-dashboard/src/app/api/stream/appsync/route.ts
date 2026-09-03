import { NextRequest } from "next/server";
import { resolveEventsEndpoint, subscribeToTelemetry } from "../../../../lib/appsync-realtime";

export const dynamic = "force-dynamic";

/**
 * GET /api/stream/appsync?did=<deploymentId>
 *
 * Server-Sent Events relay for the AppSync live-push ("no storage") tier
 * (#259). Unlike every other tier, this route does not compute freshness —
 * it has no store and no query to run. It just relays each `onTelemetry`
 * subscription frame as-is (raw device-stamped `messageTimestamp`); the
 * browser computes freshness itself as `Date.now() - messageTimestamp` the
 * instant the frame arrives (see page.tsx's useAppSyncFreshness), which is
 * the truest "no storage" measurement — no server-side hop is folded in.
 *
 * The per-slot AppSync Events API endpoint is resolved by `did` (see
 * lib/appsync-realtime.ts — SSM lookup `/workshop/<did>/events-api-endpoint`,
 * falling back to the static APPSYNC_EVENTS_ENDPOINT env var). If neither
 * resolves, or the pod's IRSA role hasn't been granted appsync:EventConnect/
 * EventSubscribe yet, this falls back to emitting synthetic telemetry frames on
 * a timer — same graceful-fallback contract as the RisingWave/TimescaleDB
 * streams, so an unconfigured/not-yet-authorized dashboard still renders and
 * never crashes the container.
 *
 * Per-hop latency instrumentation (#263, epic #246): each frame carries
 * optional `ruleDispatchTs` / `publishSentTs` (stamped in the bridge Lambda,
 * amplify/lambda/appsync-bridge/index.js — hops 2-3) and `appsyncArrivalTs`
 * (stamped in lib/appsync-realtime.ts the instant the WS subscription frame
 * reaches this process — hop 4), plus `relayForwardTs` stamped right here
 * (hop 5). Absent on mock/error-fallback frames. The full chain:
 *   messageTimestamp (device) -> ruleDispatchTs (hop2) -> publishSentTs
 *   (hop3 start) -> appsyncArrivalTs (hop3 end / hop4) -> relayForwardTs
 *   (hop5 start) -> browser arrival (hop5 end, computed client-side).
 */
export async function GET(req: NextRequest): Promise<Response> {
  const deploymentId = req.nextUrl.searchParams.get("did") ?? process.env.WORKSHOP_DEPLOYMENT_ID ?? "";
  const region = process.env.AWS_REGION ?? "us-east-1";
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

  function emitMockTelemetry() {
    send("telemetry", {
      thingName: `${deploymentId || "ws-slot00"}-edge-0`,
      // A device publishing "now" — the mock's whole point is to render as
      // near-zero freshness, matching the ~10-80ms the live tier targets.
      messageTimestamp: Date.now() - Math.round(10 + Math.random() * 60),
      deploymentId,
      source: "mock",
    });
  }

  (async () => {
    const endpoint = await resolveEventsEndpoint(deploymentId, region).catch(() => null);

    if (!endpoint) {
      sendComment("connected (mock)");
      while (!closed) {
        emitMockTelemetry();
        await new Promise(r => setTimeout(r, 2000));
      }
      return;
    }

    try {
      const sub = await subscribeToTelemetry({
        eventsEndpoint: endpoint,
        deploymentId,
        region,
        onEvent: (msg) => {
          // Hop 5 boundary (#263): the instant this relay is about to forward
          // the frame over SSE — the browser's own arrival stamp (page.tsx)
          // closes out "relay -> browser". thingName/messageTimestamp/source
          // stay exactly as before; the ruleDispatchTs..relayForwardTs fields
          // are additive and optional (absent for mock/error fallback frames).
          const relayForwardTs = Date.now();
          send("telemetry", {
            thingName: msg.thingName,
            messageTimestamp: msg.messageTimestamp,
            deploymentId: msg.deploymentId ?? deploymentId,
            source: "appsync",
            ruleDispatchTs: msg.ruleDispatchTs ?? null,
            publishSentTs: msg.publishSentTs ?? null,
            appsyncArrivalTs: msg.appsyncArrivalTs ?? null,
            relayForwardTs,
          });
        },
        onError: (message) => {
          send("tier-error", { message });
        },
        onConnected: () => sendComment("connected"),
      });

      onCancel = sub.close;

      while (!closed) {
        await new Promise(r => setTimeout(r, 1000));
      }
      sub.close();
    } catch (err) {
      console.error("[stream/appsync] error:", err);
      send("tier-error", { message: String(err instanceof Error ? err.message : err) });
      // A failed live connection still leaves the panel with *something* to
      // show rather than going permanently blank for the rest of the session.
      while (!closed) {
        emitMockTelemetry();
        await new Promise(r => setTimeout(r, 2000));
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
