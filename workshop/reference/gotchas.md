# Gotchas and Watch-Outs

Things that will bite you if you don't know about them.

| Item | Detail |
|---|---|
| **Fleet Hub EOL** | Fleet Hub was discontinued October 2025. Use the **IoT Device Management console** directly for fleet queries. |
| **Dynamic Thing Groups — eventual consistency** | Group membership evaluates asynchronously. Newly registered devices may take seconds to appear. Don't rely on synchronous membership for sequenced job targeting. |
| **Shadow size limit** | 8 KB per named shadow. Keep high-frequency telemetry in MQTT topics, not shadows. |
| **Fleet Provisioning token expiry** | The `certificateOwnershipToken` from `CreateKeysAndCertificate` expires after **1 hour**. EC2 user data must run provisioning on first boot, not deferred. |
| **IoT Jobs — max pending per device** | Don't queue more than 10–15 concurrent jobs to any single device. |
| **MSK Serverless + IoT Kafka action** | MSK Serverless does not support SASL/SCRAM. The IoT Rules Engine Kafka action requires **Provisioned MSK** with SASL/SCRAM or mTLS. |
| **Athena + Hudi MoR read amplification** | MoR queries merge base files + delta logs at read time — more I/O than CoW. Schedule async compaction via a Glue job to bound amplification during the workshop. |
| **Hudi incremental query `beginTime`** | The `beginTime` must be an exact Hudi commit instant (e.g. `20240101000000000`), not a wall-clock timestamp. Map to the nearest commit instant first via `SHOW TBLPROPERTIES`. |
| **RisingWave `SUBSCRIBE` is pull, not push** | RisingWave's subscription uses `CREATE SUBSCRIPTION` + `DECLARE CURSOR` + `FETCH` loop — a pull model, not PostgreSQL `LISTEN/NOTIFY`. The Next.js Route Handler runs the fetch loop and flushes to SSE. Include a short yield between fetches to avoid busy-waiting. |
| **API Gateway incompatible with SSE** | API Gateway HTTP and REST APIs have a hard max integration timeout of **300 s**, even with a quota increase. Use an **ALB** for SSE connections. Set ALB idle timeout to 4,000 s and emit SSE heartbeat comments (`: ping`) every 30 s from the server. |
| **ALB SSE — Cognito auth** | ALB supports Cognito JWT authentication natively via `authenticate-cognito` listener rule. JWT is validated at the ALB — no custom auth middleware needed in the Route Handler. |
| **K3s → RKE2 for production** | K3s does not have FIPS 140-2 validated cryptography. For regulated or HSE-sensitive environments, use RKE2 before going to production. |
| **IoT Device Client — no publicly reachable pre-built artifacts** | The release CI publishes Docker images to ECR public (`aws-iot-device-client/aws-iot-device-client` and `aws-iot-device-client/aws-iot-device-client-base-images`) using an internal AWS account, but both repos return `NAME_UNKNOWN` to external callers. GitHub Releases has source archives only. You must build from source. See [docs/aws-iot-device-client-build-model.md](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/docs/aws-iot-device-client-build-model.md). |
