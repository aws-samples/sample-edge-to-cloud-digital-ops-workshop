// IoT Rule → MSK bridge
// Receives telemetry events from IoT Core and writes them to the raw.telemetry Kafka topic.
// Bundled with kafkajs via package.json — deployed from amplify/lambda/msk-bridge/.
import { KafkaClient, GetBootstrapBrokersCommand } from "@aws-sdk/client-kafka";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { Kafka, logLevel } from "kafkajs";

const region = process.env.REGION;
const clusterArn = process.env.MSK_CLUSTER_ARN;
const credSecretId = process.env.MSK_CRED_SECRET;

let producer;

async function getProducer() {
  if (producer) return producer;

  const sm = new SecretsManagerClient({ region });
  const secret = JSON.parse(
    (await sm.send(new GetSecretValueCommand({ SecretId: credSecretId }))).SecretString
  );

  const kafkaClient = new KafkaClient({ region });
  const brokerStr = (
    await kafkaClient.send(new GetBootstrapBrokersCommand({ ClusterArn: clusterArn }))
  ).BootstrapBrokerStringSaslScram512;

  const kafka = new Kafka({
    brokers: brokerStr.split(","),
    ssl: true,
    sasl: {
      mechanism: "scram-sha-512",
      username: secret.username,
      password: secret.password,
    },
    logLevel: logLevel.ERROR,
  });

  producer = kafka.producer();
  await producer.connect();
  return producer;
}

export const handler = async (event) => {
  const p = await getProducer();
  await p.send({
    topic: "raw.telemetry",
    messages: [{ value: JSON.stringify(event) }],
  });
};
