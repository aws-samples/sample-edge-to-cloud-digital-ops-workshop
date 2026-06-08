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
| S3 table format | Hudi MoR | MSK Connect Hudi Sink runs directly against MSK — no Spark/Glue cluster required; MoR appends delta logs so new rows are queryable within seconds of connector flush interval |
| Hudi over Iceberg | Hudi MoR with incremental query | Hudi's native incremental query path (`beginTime` cursor) pulls only changed rows — no full table scan at 5-second refresh; Iceberg has no equivalent primitive |
| Fleet Provisioning approach | By claim | Claim cert in Secrets Manager, retrieved by EC2 instance profile; fully automated CDK deployment with no human commissioning step |

---

## References

- [AppSync Events HTTP publish](https://docs.aws.amazon.com/appsync/latest/eventapi/publish-http.html)
- [API Gateway max timeout (300 s)](https://aws.amazon.com/about-aws/whats-new/2024/06/amazon-api-gateway-integration-timeout-limit-29-seconds/)
- [ALB idle timeout (max 4,000 s)](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html)
- [RisingWave SUBSCRIBE](https://risingwavelabs.mintlify.app/delivery/subscription)
- [K3s docs](https://docs.k3s.io/)
- [React Flow](https://reactflow.dev/)
- [Hudi incremental query](https://hudi.apache.org/docs/querying_data#incremental-query)
- [IoT Fleet Provisioning by claim](https://docs.aws.amazon.com/iot/latest/developerguide/provision-wo-cert.html)
