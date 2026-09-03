import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import WebSocket from "ws";

// AppSync live-push tier (#259) — the pod-side half of the "no storage" leg of
// the freshness comparison. Real device telemetry flows device MQTT → IoT Rule
// → bridge Lambda (amplify/lambda/appsync-bridge) → AppSync **Events API**
// `/event` channel `/telemetry/<did>/<thing>` → this WebSocket subscriber. No
// database in the path.
//
// The dashboard is one shared instance for every slot (#253), but each slot
// owns its OWN Events API (amplify/custom/participant-stack.ts), so — unlike the
// RisingWave/TimescaleDB/Athena/InfluxDB tiers (one shared backend, filtered by
// deployment_id) — there is no single endpoint to hardcode; it is resolved per
// `?did=` at request time from SSM (`/workshop/<did>/events-api-endpoint`).
//
// Pod-side auth: sign the realtime WebSocket handshake AND each subscribe with
// the pod's OWN IRSA role (IAM/SigV4), never hand AWS credentials to the
// browser. The IRSA role (platform-stack.ts CloudDashboardRole, granted
// appsync:EventConnect/EventSubscribe + ssm:GetParameter) is annotated onto the
// dashboard ServiceAccount by Helm (dashboard.serviceAccountRoleArn). If that
// annotation / SSM param is missing, the endpoint resolves to null and the tier
// gracefully falls back to mock data, exactly like Athena/InfluxDB do when their
// env vars are unset (see stream/appsync/route.ts).

const SSM_CACHE_TTL_MS = 60_000;
const ssmCache = new Map<string, { endpoint: string | null; expiresAt: number }>();

async function lookupEventsEndpointFromSsm(deploymentId: string, region: string): Promise<string | null> {
  const cached = ssmCache.get(deploymentId);
  if (cached && cached.expiresAt > Date.now()) return cached.endpoint;

  try {
    const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
    const ssm = new SSMClient({ region });
    const { Parameter } = await ssm.send(
      new GetParameterCommand({ Name: `/workshop/${deploymentId}/events-api-endpoint` })
    );
    const endpoint = Parameter?.Value ?? null;
    ssmCache.set(deploymentId, { endpoint, expiresAt: Date.now() + SSM_CACHE_TTL_MS });
    return endpoint;
  } catch {
    // No permission, param doesn't exist, or no credentials at all (local
    // dev) — treat exactly like "not configured", never throw.
    ssmCache.set(deploymentId, { endpoint: null, expiresAt: Date.now() + SSM_CACHE_TTL_MS });
    return null;
  }
}

// Resolves the per-slot AppSync Events API HTTP endpoint (`https://<host>/event`).
// Prefers the SSM parameter every ParticipantStack publishes (correct per-slot
// value, same deploymentId-scoping as the other tiers) and falls back to the
// static APPSYNC_EVENTS_ENDPOINT env var (helm dashboard.appsyncEventsEndpoint)
// for a single-slot override or local dev.
export async function resolveEventsEndpoint(deploymentId: string, region: string): Promise<string | null> {
  if (deploymentId) {
    const fromSsm = await lookupEventsEndpointFromSsm(deploymentId, region);
    if (fromSsm) return fromSsm;
  }
  return process.env.APPSYNC_EVENTS_ENDPOINT ?? null;
}

export interface TelemetryMessage {
  thingName: string;
  messageTimestamp: number;
  cpuPct?: number | null;
  memUsedPct?: number | null;
  diskUsedPct?: number | null;
  deploymentId?: string | null;
}

// Maps a raw Events API telemetry frame (snake_case, as the device publishes and
// the bridge Lambda forwards verbatim — see job-scripts/telemetry-v1.sh) onto
// the camelCase shape the dashboard uses. message_timestamp is epoch-ms,
// device-stamped immediately before publish, so freshness = Date.now() - it.
function parseTelemetry(raw: Record<string, unknown>): TelemetryMessage | null {
  const ts = raw.message_timestamp ?? raw.messageTimestamp;
  const messageTimestamp = typeof ts === "number" ? ts : Number(ts);
  if (!Number.isFinite(messageTimestamp)) return null;
  const num = (v: unknown): number | null => {
    if (v == null) return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    thingName: String(raw.thing_name ?? raw.thingName ?? "unknown"),
    messageTimestamp,
    cpuPct: num(raw.cpu_pct ?? raw.cpuPct),
    memUsedPct: num(raw.mem_used_pct ?? raw.memUsedPct),
    diskUsedPct: num(raw.disk_used_pct ?? raw.diskUsedPct),
    deploymentId: raw.deployment_id != null ? String(raw.deployment_id) : null,
  };
}

// Base64URL (RFC 4648 §5): the Events API carries the connection-auth object as
// a WebSocket subprotocol token (`header-<...>`), and `+`, `/`, `=` are NOT
// valid Sec-WebSocket-Protocol token characters — so plain base64 breaks the
// handshake. The `authorization` field of subscribe messages is a JSON object,
// not encoded.
function toBase64Url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// SigV4-signs a would-be `POST https://<host>/event` with the pod's IRSA creds
// and returns the exact header object the AWS AppSync Events IAM WebSocket
// protocol expects (see
// docs.aws.amazon.com/appsync/latest/eventapi/event-api-websocket-protocol.html
// — "AWS Identity and Access Management (IAM) subprotocol format"):
//   accept + content-encoding: amz-1.0 + content-type are REQUIRED constant
//   headers that must be part of the signature; the signer adds x-amz-date,
//   Authorization, and (temporary creds) X-Amz-Security-Token. `host` is the
//   HTTP endpoint host and is required for IAM. body is "{}" to connect, or the
//   stringified `{channel}` (subscribe) / `{channel,events}` (publish) request.
async function signEventApiRequest(
  host: string,
  region: string,
  body: string
): Promise<Record<string, string>> {
  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region,
    service: "appsync",
    sha256: Sha256,
  });

  const request = new HttpRequest({
    method: "POST",
    protocol: "https:",
    hostname: host,
    path: "/event",
    headers: {
      accept: "application/json, text/javascript",
      "content-encoding": "amz-1.0",
      "content-type": "application/json; charset=UTF-8",
      host,
    },
    body,
  });

  const signed = await signer.sign(request);
  const h = signed.headers as Record<string, string>;
  // Return every header the signer actually signed over — AppSync validates the
  // signature against the SignedHeaders list in Authorization, so any signed
  // header missing from this object fails the handshake.
  return {
    accept: "application/json, text/javascript",
    "content-encoding": "amz-1.0",
    "content-type": "application/json; charset=UTF-8",
    host,
    "x-amz-date": h["x-amz-date"],
    Authorization: h["authorization"] ?? h["Authorization"],
    ...(h["x-amz-security-token"] ? { "X-Amz-Security-Token": h["x-amz-security-token"] } : {}),
    ...(h["x-amz-content-sha256"] ? { "x-amz-content-sha256": h["x-amz-content-sha256"] } : {}),
  };
}

export interface AppSyncSubscription {
  close: () => void;
}

// Opens the AppSync Events API realtime WebSocket, performs the IAM-signed
// handshake, subscribes to `/telemetry/<deploymentId>/*`, and invokes `onEvent`
// for every telemetry frame — one per device MQTT publish that reaches IoT Core
// and is forwarded by the bridge Lambda. `onEvent` receives the raw
// device-stamped messageTimestamp; freshness is computed by the caller from the
// moment the SSE frame reaches the browser (Date.now() - messageTimestamp), not
// here — see stream/appsync/route.ts + page.tsx.
export async function subscribeToTelemetry(opts: {
  eventsEndpoint: string;
  deploymentId: string;
  region: string;
  onEvent: (msg: TelemetryMessage) => void;
  onError: (message: string) => void;
  onConnected?: () => void;
}): Promise<AppSyncSubscription> {
  const { eventsEndpoint, deploymentId, region, onEvent, onError, onConnected } = opts;
  const url = new URL(eventsEndpoint);
  const host = url.host; // <id>.appsync-api.<region>.amazonaws.com
  const realtimeHost = host.replace("appsync-api", "appsync-realtime-api");
  const channel = `/telemetry/${deploymentId || "*"}/*`;

  // The connection handshake carries a signed POST-to-/event-with-body-"{}" as a
  // base64url WebSocket subprotocol alongside the required `aws-appsync-event-ws`.
  const connectAuth = await signEventApiRequest(host, region, "{}");
  const wsUrl = `wss://${realtimeHost}/event/realtime`;

  // Both subprotocols go through `ws`'s `protocols` argument (which negotiates
  // Sec-WebSocket-Protocol itself) — a raw header mismatches the handshake.
  const ws = new WebSocket(wsUrl, ["aws-appsync-event-ws", `header-${toBase64Url(connectAuth)}`]);
  const subscriptionId = `appsync-telemetry-${Math.random().toString(36).slice(2)}`;
  let closed = false;
  // connectionTimeoutMs (from connection_ack, ~300s) is the max gap between
  // keep-alives before we must presume the connection dead.
  let connectionTimeoutMs = 300_000;
  let keepaliveTimer: ReturnType<typeof setTimeout> | null = null;

  const armKeepaliveWatchdog = () => {
    if (keepaliveTimer) clearTimeout(keepaliveTimer);
    keepaliveTimer = setTimeout(() => {
      if (!closed) onError("appsync keepalive timeout");
    }, connectionTimeoutMs + 5_000);
  };

  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "connection_init" }));
  });

  ws.on("message", async (raw: WebSocket.RawData) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case "connection_ack": {
        if (typeof msg.connectionTimeoutMs === "number") connectionTimeoutMs = msg.connectionTimeoutMs;
        armKeepaliveWatchdog();
        try {
          const authorization = await signEventApiRequest(host, region, JSON.stringify({ channel }));
          ws.send(JSON.stringify({ type: "subscribe", id: subscriptionId, channel, authorization }));
        } catch (e: any) {
          onError(`subscribe failed: ${e?.message ?? e}`);
        }
        return;
      }
      case "ka":
        armKeepaliveWatchdog();
        return;
      case "subscribe_success":
        onConnected?.();
        return;
      case "data": {
        if (msg.id !== subscriptionId) return;
        // `event` is an array of stringified JSON values (the bridge publishes
        // one telemetry object per frame).
        const events: unknown[] = Array.isArray(msg.event) ? msg.event : [msg.event];
        for (const e of events) {
          let parsed: Record<string, unknown> | null = null;
          try {
            parsed = typeof e === "string" ? JSON.parse(e) : (e as Record<string, unknown>);
          } catch {
            parsed = null;
          }
          if (!parsed) continue;
          const telemetry = parseTelemetry(parsed);
          if (telemetry) onEvent(telemetry);
        }
        return;
      }
      case "subscribe_error":
      case "broadcast_error":
      case "error":
      case "connection_error":
        onError(JSON.stringify(msg.errors ?? msg.payload ?? msg));
        return;
      default:
        return;
    }
  });

  ws.on("error", (err: Error) => {
    onError(err.message);
  });

  ws.on("close", () => {
    if (keepaliveTimer) clearTimeout(keepaliveTimer);
    if (!closed) onError("appsync connection closed");
  });

  return {
    close: () => {
      closed = true;
      if (keepaliveTimer) clearTimeout(keepaliveTimer);
      try {
        ws.send(JSON.stringify({ type: "unsubscribe", id: subscriptionId }));
      } catch {
        // socket may already be closed
      }
      try {
        ws.close();
      } catch {
        // ignore
      }
    },
  };
}
