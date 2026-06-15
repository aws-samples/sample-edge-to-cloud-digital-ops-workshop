/**
 * Custom resource Lambda: creates an IoT claim certificate and stores it in Secrets Manager.
 *
 * Using a proper Lambda instead of AwsCustomResource avoids:
 *   1. The 4KB CFn response-size limit (cert PEM + private key exceeds it)
 *   2. PEM newlines becoming control characters in CFn token substitution
 */

const {
  IoTClient,
  CreateKeysAndCertificateCommand,
  AttachPolicyCommand,
  DetachPolicyCommand,
  DescribeCertificateCommand,
  UpdateCertificateCommand,
  DeleteCertificateCommand,
} = require("@aws-sdk/client-iot");
const { SecretsManagerClient, PutSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const https = require("https");
const url = require("url");

const iot = new IoTClient({});
const sm = new SecretsManagerClient({});

async function sendResponse(event, context, status, data, reason) {
  const body = JSON.stringify({
    Status: status,
    Reason: reason || `See CloudWatch log stream: ${context.logStreamName}`,
    PhysicalResourceId: data?.PhysicalResourceId || event.PhysicalResourceId || context.logStreamName,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data || {},
  });

  const parsed = url.parse(event.ResponseURL);
  await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.path,
      method: "PUT",
      headers: { "Content-Type": "", "Content-Length": Buffer.byteLength(body) },
    }, (res) => { res.resume(); resolve(); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event, context) => {
  console.log("Event:", JSON.stringify(event));
  const { RequestType, ResourceProperties } = event;
  const { PolicyName, SecretArn } = ResourceProperties;

  try {
    if (RequestType === "Create") {
      const certResp = await iot.send(new CreateKeysAndCertificateCommand({ setAsActive: true }));
      const { certificateId, certificateArn, certificatePem, keyPair } = certResp;

      await iot.send(new AttachPolicyCommand({ policyName: PolicyName, target: certificateArn }));

      // JSON.stringify handles PEM newlines correctly — no CFn token substitution involved
      await sm.send(new PutSecretValueCommand({
        SecretId: SecretArn,
        SecretString: JSON.stringify({
          certificate: certificatePem,
          privateKey: keyPair.PrivateKey,
          certificateArn,
          certificateId,
        }),
      }));

      await sendResponse(event, context, "SUCCESS", {
        PhysicalResourceId: certificateId,
        CertificateId: certificateId,
        CertificateArn: certificateArn,
      });
    } else if (RequestType === "Delete") {
      const certId = event.PhysicalResourceId;
      if (certId && certId !== context.logStreamName) {
        const describe = await iot.send(new DescribeCertificateCommand({ certificateId: certId })).catch(() => null);
        const certArn = describe?.certificateDescription?.certificateArn;
        if (certArn) {
          await iot.send(new DetachPolicyCommand({ policyName: PolicyName, target: certArn })).catch(() => {});
        }
        await iot.send(new UpdateCertificateCommand({ certificateId: certId, newStatus: "INACTIVE" })).catch(() => {});
        await iot.send(new DeleteCertificateCommand({ certificateId: certId, forceDelete: true })).catch(() => {});
      }
      await sendResponse(event, context, "SUCCESS", { PhysicalResourceId: certId });
    } else {
      await sendResponse(event, context, "SUCCESS", { PhysicalResourceId: event.PhysicalResourceId });
    }
  } catch (err) {
    console.error(err);
    await sendResponse(event, context, "FAILED", {}, String(err));
  }
};
