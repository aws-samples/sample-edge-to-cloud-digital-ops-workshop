# Architecture Decisions

Key technical decisions made during the design of this workshop architecture.

| Decision | Choice | Rationale |
|---|---|---|
| AppSync private VPC resources | Lambda resolver (proxy) | AppSync HTTP data sources support public endpoints only |
| AppSync real-time backend publishing | HTTP POST to `/event` | No WebSocket required for publishers; subscribers use WebSocket |
| Cloud live data (RisingWave) | ALB → Next.js SSE + RisingWave `SUBSCRIBE` | API Gateway max timeout is 300 s — incompatible with long-lived SSE; ALB supports up to 4,000 s idle timeout |
| Cloud live data (TimescaleDB) | ALB → Next.js SSE + PostgreSQL `LISTEN/NOTIFY` | TimescaleDB has no `SUBSCRIBE` primitive; insert trigger fires `pg_notify`, Next.js listens and re-queries a 60 s window |
| Edge live data (RisingWave) | Next.js SSE + RisingWave `SUBSCRIBE` | No GraphQL server needed; `node-postgres` connects directly via PG wire |
| Edge K8s distribution | K3s (workshop) / RKE2 (production) | K3s bootstraps in minutes; RKE2 is FIPS 140-2 validated for regulated environments |
| Industrial site HMI | React Flow | MIT license, 36.9k GitHub stars, custom SVG nodes, built-in mouseover interaction |
| IoT Jobs fleet deployment timer | 45-min in-progress timer | K3s install ≈ 10–20 min; 45 min gives safe margin within 7-day max |
| MSK type for IoT Rules Kafka action | Provisioned MSK only | MSK Serverless does not support SASL/SCRAM; IoT Kafka action requires Provisioned |
| S3 table format | Apache Iceberg via Amazon Data Firehose | An IoT Rule Firehose action delivers telemetry straight to a DirectPut Firehose stream that writes to Iceberg (Glue Data Catalog) natively — no custom connector or Spark/Glue cluster required; fully-managed, config-only delivery |
| Archive-tier delivery mechanism | Amazon Data Firehose (DirectPut, fed by an IoT Rule), chosen over Apache Hudi (original design) and a custom Amazon Managed Service for Apache Flink sink (interim design) | Hudi's MoR/CoW model needed a hand-maintained connector; the Flink app that replaced it existed only to bundle `iceberg-flink-runtime` + a Hadoop S3A stack for packaging, with no meaningful custom stream logic. A direct IoT Rule → Firehose → Iceberg path removes both the connector and the fat-jar maintenance burden entirely, and drops the MSK hop from the archive tier — see [`amplify/custom/platform-stack.ts`](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/amplify/custom/platform-stack.ts) |
| Fleet Provisioning approach | By claim | Claim cert in Secrets Manager, retrieved by EC2 instance profile; fully automated CDK deployment with no human commissioning step |

---

## References

- [AppSync Events HTTP publish](https://docs.aws.amazon.com/appsync/latest/eventapi/publish-http.html)
- [API Gateway max timeout (300 s)](https://aws.amazon.com/about-aws/whats-new/2024/06/amazon-api-gateway-integration-timeout-limit-29-seconds/)
- [ALB idle timeout (max 4,000 s)](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html)
- [RisingWave SUBSCRIBE](https://risingwavelabs.mintlify.app/delivery/subscription)
- [K3s docs](https://docs.k3s.io/)
- [React Flow](https://reactflow.dev/)
- [Firehose Apache Iceberg destination](https://docs.aws.amazon.com/firehose/latest/dev/apache-iceberg-destination.html)
- [IoT Fleet Provisioning by claim](https://docs.aws.amazon.com/iot/latest/developerguide/provision-wo-cert.html)
