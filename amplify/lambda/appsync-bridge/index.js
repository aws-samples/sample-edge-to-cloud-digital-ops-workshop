// Bridges IoT Core telemetry messages to AppSync Events API via IAM signing.
// Uses only packages available in the Node 22 Lambda runtime:
//   @aws-sdk/signature-v4, @aws-sdk/credential-provider-node, crypto (built-in), https (built-in)
//
// #262 (epic #246) looked at removing this Lambda hop entirely via a direct IoT
// Rule http action straight to the Events API (SigV4-signed, no compute in the
// path). That requires the action's destination URL to be a *confirmed*
// TopicRuleDestination. Per AWS IoT's confirmation protocol (docs: "HTTP
// action destinations"), the `confirmationToken` needed to call
// ConfirmTopicRuleDestination is delivered ONLY inside the confirmation POST
// IoT sends to the destination's own `confirmationUrl` -- and `confirmationUrl`
// must be a prefix of the delivery `url`, i.e. a path on the AppSync endpoint
// itself. We don't run code on that AWS-managed host, so we can never receive
// that POST body or its token, and there is no other API that exposes a lost
// token. The destination is therefore stuck IN_PROGRESS forever and the http
// action can never go ENABLED -- a hard blocker, not a to-do; no declarative
// or manual workaround exists. This Lambda stays; the mitigation taken instead
// is cutting its per-message overhead (the keep-alive agent below, killing the
// per-call TLS handshake) and instrumenting the hops that remain (#263).
"use strict";

const https = require("https");
const crypto = require("crypto");
const { defaultProvider } = require("@aws-sdk/credential-provider-node");
const { SignatureV4 } = require("@aws-sdk/signature-v4");

// One pooled TLS connection reused across invocations of the same warm
// execution environment, instead of a fresh TCP/TLS handshake per message --
// the single biggest Lambda-side cost #262 measured.
const keepAliveAgent = new https.Agent({ keepAlive: true });

let credProvider;

// AwsCrypto-compatible hash for SignatureV4. SigV4 uses this constructor in TWO
// modes: a plain SHA-256 (payload hash) AND — critically — a keyed HMAC when
// given a secret (`new NodeSha256(signingKey)`) during signing-key derivation.
// It MUST honour that key: a plain-hash-only impl silently derives the wrong
// signing key, so every publish is rejected with a 400 "signature we calculated
// does not match" that the fire-and-forget response handling below would hide.
class NodeSha256 {
  constructor(secret) {
    this.hash = secret ? crypto.createHmac("sha256", secret) : crypto.createHash("sha256");
  }
  update(data) { this.hash.update(data); return this; }
  async digest() { return this.hash.digest(); }
}

exports.handler = async (event) => {
  // Hop 2 boundary (#263): the IoT Rule invokes this Lambda synchronously, so
  // "now" at handler entry is the closest observable proxy for rule-dispatch
  // completion / Lambda-invoke start.
  const ruleDispatchTs = Date.now();

  const host = process.env.APPSYNC_HTTP_ENDPOINT;
  const deploymentId = process.env.DEPLOYMENT_ID;
  const region = process.env.REGION;
  const thingName = event.thing_name ?? "unknown";
  const channel = `/telemetry/${deploymentId}/${thingName}`;

  if (!credProvider) credProvider = defaultProvider();
  const creds = await credProvider();

  const signer = new SignatureV4({
    credentials: creds,
    region,
    service: "appsync",
    sha256: NodeSha256,
  });

  // Hop 3 start (#263): everything above is Lambda-side credential-resolve
  // overhead; everything below is sign + network + AppSync fan-out. Stamped
  // onto the forwarded event itself (rather than a wrapper) since the bridge
  // publishes `event` through to the channel verbatim with no reshaping step
  // downstream to attach metadata to. The matching "publish-return" instant
  // can't travel the same way — it isn't known until *after* this exact call
  // resolves, so it can never be an argument of its own payload; the full
  // round trip is logged below instead. Hops 4-5 continue the timeline
  // server-side in cloud-dashboard's SSE relay (appsync-realtime.ts /
  // stream/appsync/route.ts), which stamps arrival the instant the
  // subscription frame reaches the relay process.
  const publishSentTs = Date.now();
  const instrumentedEvent = { ...event, ruleDispatchTs, publishSentTs };
  const body = JSON.stringify({ channel, events: [JSON.stringify(instrumentedEvent)] });

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]/g, "").replace(/\.\d{3}/, "").slice(0, 15) + "Z";

  const signed = await signer.sign({
    method: "POST",
    hostname: host,
    path: "/event",
    headers: {
      host,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      "x-amz-date": amzDate,
    },
    body,
  });

  await new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: host, path: "/event", method: "POST", headers: signed.headers, agent: keepAliveAgent },
      (res) => {
        let payload = "";
        res.on("data", (chunk) => { payload += chunk; });
        res.on("end", () => {
          const publishReturnTs = Date.now();
          // Surface non-2xx (e.g. a 400 signature mismatch) instead of silently
          // dropping it — a swallowed 400 once made every publish a no-op while
          // the Lambda reported clean, successful invocations (#259).
          if (res.statusCode < 200 || res.statusCode >= 300) {
            console.error(`AppSync publish failed: ${res.statusCode} channel=${channel} body=${payload.slice(0, 300)}`);
          }
          console.log(JSON.stringify({
            msg: "appsync-bridge-hop-timing",
            thingName,
            ruleDispatchTs,
            publishSentTs,
            publishReturnTs,
            credentialResolveMs: publishSentTs - ruleDispatchTs,
            signAndPublishRoundTripMs: publishReturnTs - publishSentTs,
            statusCode: res.statusCode,
          }));
          resolve();
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
};
