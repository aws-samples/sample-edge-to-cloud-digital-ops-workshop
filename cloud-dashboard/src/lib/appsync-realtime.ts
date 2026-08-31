import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import WebSocket from "ws";

// AppSync live-push tier (#259) — the pod-side half of the "no storage" leg of
// the freshness comparison. The dashboard is one shared instance for every
// slot (#253), but each slot owns its OWN AppSync GraphQL API (data-stack.ts),
// so unlike the RisingWave/TimescaleDB/Athena/InfluxDB tiers (one shared
// backend, filtered by deployment_id) there is no single endpoint to hardcode
// — it has to be resolved per `?did=` at request time.
//
// Pod-side auth decision (recorded here and in the PR description): sign the
// realtime WebSocket handshake with the pod's OWN IRSA role (IAM/SigV4),
// never hand AWS credentials to the browser. This mirrors the existing
// Athena tier's IAM story (helm/cloud-analytics/values.yaml: "wiring that IAM
// role is left to the deployer") rather than adding a new platform-stack IRSA
// role in this change — until the dashboard's ServiceAccount is annotated
// with a role that has been granted `appsync:GraphQL` (and, for the SSM
// lookup below, `ssm:GetParameter` on `/workshop/*/graphql-endpoint`) on the
// target slot's API, this tier gracefully falls back to mock data, exactly
// like Athena/InfluxDB do today when their env vars are unset.

const SSM_CACHE_TTL_MS = 60_000;
const ssmCache = new Map<string, { endpoint: string | null; expiresAt: number }>();

async function lookupGraphqlEndpointFromSsm(deploymentId: string, region: string): Promise<string | null> {
  const cached = ssmCache.get(deploymentId);
  if (cached && cached.expiresAt > Date.now()) return cached.endpoint;

  try {
    const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
    const ssm = new SSMClient({ region });
    const { Parameter } = await ssm.send(
      new GetParameterCommand({ Name: `/workshop/${deploymentId}/graphql-endpoint` })
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

// Resolves the per-slot AppSync GraphQL (HTTPS) endpoint. Prefers the SSM
// parameter every DataNestedStack publishes (correct per-slot value, same
// deploymentId-scoping pattern as the other tiers) and falls back to the
// static APPSYNC_GRAPHQL_ENDPOINT env var (helm/cloud-analytics's
// dashboard.appsyncGraphqlEndpoint) for a single-slot override or local dev.
export async function resolveGraphqlEndpoint(deploymentId: string, region: string): Promise<string | null> {
  if (deploymentId) {
    const fromSsm = await lookupGraphqlEndpointFromSsm(deploymentId, region);
    if (fromSsm) return fromSsm;
  }
  return process.env.APPSYNC_GRAPHQL_ENDPOINT ?? null;
}

interface TelemetryMessage {
  thingName: string;
  messageTimestamp: number;
  cpuPct?: number | null;
  memUsedPct?: number | null;
  diskUsedPct?: number | null;
  deploymentId?: string | null;
}

const ON_TELEMETRY_SUBSCRIPTION = `subscription OnTelemetry {
  onTelemetry {
    thingName
    messageTimestamp
    cpuPct
    memUsedPct
    diskUsedPct
    deploymentId
  }
}`;

// Signs a would-be HTTP request to the AppSync HTTP endpoint with the pod's
// IRSA credentials and returns just the header object AppSync's realtime
// protocol expects — either for the `connection_init` handshake (body "{}")
// or per-subscription in the `start` message's `extensions.authorization`
// (body = the GraphQL operation). Same signing scheme AppSync uses to
// authorize the equivalent HTTP call — the realtime protocol just carries the
// signature over the WS handshake / message instead.
async function signAppSyncRequest(
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
    path: "/graphql",
    headers: {
      host,
      "content-type": "application/json; charset=UTF-8",
    },
    body,
  });

  const signed = await signer.sign(request);
  const headers = signed.headers as Record<string, string>;
  return {
    host,
    "content-type": headers["content-type"],
    Authorization: headers["authorization"] ?? headers["Authorization"],
    "X-Amz-Date": headers["x-amz-date"] ?? headers["X-Amz-Date"],
    ...(headers["x-amz-security-token"] ? { "X-Amz-Security-Token": headers["x-amz-security-token"] } : {}),
  };
}

function toBase64Url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

export interface AppSyncSubscription {
  close: () => void;
}

// Opens the AppSync realtime WebSocket, performs the IAM-signed handshake,
// subscribes to `onTelemetry`, and invokes `onEvent` for every message — one
// per publishTelemetry mutation on the target slot's API, i.e. one per device
// MQTT publish that reaches IoT Core (see amplify/custom/schema.graphql).
// `onEvent` receives the raw device-stamped messageTimestamp; freshness is
// computed by the caller from the moment the SSE frame reaches the browser
// (Date.now() - messageTimestamp), not here — see route.ts.
export async function subscribeToTelemetry(opts: {
  httpEndpoint: string;
  region: string;
  onEvent: (msg: TelemetryMessage) => void;
  onError: (message: string) => void;
  onConnected?: () => void;
}): Promise<AppSyncSubscription> {
  const { httpEndpoint, region, onEvent, onError, onConnected } = opts;
  const httpUrl = new URL(httpEndpoint);
  const host = httpUrl.host;
  const realtimeHost = host.replace("appsync-api", "appsync-realtime-api");

  const connectHeader = await signAppSyncRequest(host, region, "{}");
  const wsUrl =
    `wss://${realtimeHost}/graphql?header=${toBase64Url(connectHeader)}&payload=${toBase64Url({})}`;

  const ws = new WebSocket(wsUrl, { headers: { "Sec-WebSocket-Protocol": "graphql-ws" } });
  const subscriptionId = `appsync-telemetry-${Math.random().toString(36).slice(2)}`;
  let closed = false;
  let keepaliveTimer: ReturnType<typeof setTimeout> | null = null;

  const armKeepaliveWatchdog = () => {
    if (keepaliveTimer) clearTimeout(keepaliveTimer);
    // AppSync sends a `ka` roughly every few seconds while connected; if none
    // arrive for 30s the connection is presumed dead.
    keepaliveTimer = setTimeout(() => {
      if (!closed) onError("appsync keepalive timeout");
    }, 30_000);
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

    if (msg.type === "connection_ack") {
      armKeepaliveWatchdog();
      try {
        const query = JSON.stringify({ query: ON_TELEMETRY_SUBSCRIPTION, variables: {} });
        const authorization = await signAppSyncRequest(host, region, query);
        ws.send(
          JSON.stringify({
            id: subscriptionId,
            type: "start",
            payload: {
              data: query,
              extensions: { authorization },
            },
          })
        );
      } catch (e: any) {
        onError(`subscribe failed: ${e?.message ?? e}`);
      }
      return;
    }

    if (msg.type === "ka") {
      armKeepaliveWatchdog();
      return;
    }

    if (msg.type === "start_ack") {
      onConnected?.();
      return;
    }

    if (msg.type === "data" && msg.id === subscriptionId) {
      const telemetry = msg.payload?.data?.onTelemetry;
      if (telemetry) onEvent(telemetry as TelemetryMessage);
      return;
    }

    if (msg.type === "error" || msg.type === "connection_error") {
      onError(JSON.stringify(msg.payload ?? msg));
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
        ws.send(JSON.stringify({ type: "stop", id: subscriptionId }));
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
