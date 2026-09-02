// Bridges IoT Core telemetry messages to AppSync Events API via IAM signing.
// Uses only packages available in the Node 22 Lambda runtime:
//   @aws-sdk/signature-v4, @aws-sdk/credential-provider-node, crypto (built-in), https (built-in)
"use strict";

const https = require("https");
const crypto = require("crypto");
const { defaultProvider } = require("@aws-sdk/credential-provider-node");
const { SignatureV4 } = require("@aws-sdk/signature-v4");

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
  const host = process.env.APPSYNC_HTTP_ENDPOINT;
  const deploymentId = process.env.DEPLOYMENT_ID;
  const region = process.env.REGION;
  const thingName = event.thing_name ?? "unknown";
  const channel = `/telemetry/${deploymentId}/${thingName}`;
  const body = JSON.stringify({ channel, events: [JSON.stringify(event)] });

  if (!credProvider) credProvider = defaultProvider();
  const creds = await credProvider();

  const signer = new SignatureV4({
    credentials: creds,
    region,
    service: "appsync",
    sha256: NodeSha256,
  });

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
      { hostname: host, path: "/event", method: "POST", headers: signed.headers },
      (res) => {
        let payload = "";
        res.on("data", (chunk) => { payload += chunk; });
        res.on("end", () => {
          // Surface non-2xx (e.g. a 400 signature mismatch) instead of silently
          // dropping it — a swallowed 400 once made every publish a no-op while
          // the Lambda reported clean, successful invocations (#259).
          if (res.statusCode < 200 || res.statusCode >= 300) {
            console.error(`AppSync publish failed: ${res.statusCode} channel=${channel} body=${payload.slice(0, 300)}`);
          }
          resolve();
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
};
