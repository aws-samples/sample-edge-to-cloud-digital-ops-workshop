// Bridges IoT Core telemetry messages to AppSync Events API via IAM signing.
// Uses only packages available in the Node 22 Lambda runtime:
//   @aws-sdk/signature-v4, @aws-sdk/credential-provider-node, crypto (built-in), https (built-in)
"use strict";

const https = require("https");
const crypto = require("crypto");
const { defaultProvider } = require("@aws-sdk/credential-provider-node");
const { SignatureV4 } = require("@aws-sdk/signature-v4");

let credProvider;

class NodeSha256 {
  constructor() { this.hash = crypto.createHash("sha256"); }
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
      (res) => { res.resume(); res.on("end", resolve); }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
};
