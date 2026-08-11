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
| Slot topology | One shared `WorkshopPlatformStack` with per-slot **nested** stacks (Auth + Data + Participant), driven by a `WORKSHOP_SLOTS` list — chosen over the previous model of one Amplify (`ampx sandbox`) backend + a top-level `ParticipantStack` per slot | A single `cdk deploy` target now brings up the platform and every slot, so the deploy is one idempotent operation that a cloud orchestrator can run fire-and-forget (see below). The auth/data resources that Amplify Gen 2 (`defineAuth`/`defineData`) used to own are now plain CDK constructs (`amplify/custom/auth-stack.ts`, `data-stack.ts`, `schema.graphql`), removing the `ampx`-owned lifecycle entirely. **Accepted trade-off:** a slot no longer has its own top-level stack, so there is no independent per-slot `cdk destroy`. Removing one slot is now a platform *update* — drop it from the persisted active-slot set and re-deploy (`scripts/delete-slot.sh`, `scripts/slot-list.sh`); CFN then deletes that slot's three nested stacks while every other slot and all shared infra stay put. The active-slot list is persisted in SSM (`/workshop/platform/active-slots`) precisely because `WORKSHOP_SLOTS` is authoritative — a deploy that omitted a slot would tear it down, so add/remove must union with the persisted set. |
| Async, fire-and-forget deploy | Cloud-side CodeBuild orchestrator (`workshop-deploy-orchestrator`) runs the single deploy + per-slot post-deploy tail; the GitHub `deploy.yml` workflow only *triggers* it and exits | A full deploy is 20-40+ min. Blocking a GitHub Actions runner (or a laptop) for that long is wasteful and fragile. `aws codebuild start-build` returns a build id immediately as a pollable handle (`scripts/trigger-deploy.sh` → `scripts/poll-deploy.sh`), so the trigger is near-instant and the deploy runs in the cloud. Idempotent + `concurrentBuildLimit=1` so re-runs and concurrent dispatches never race the shared CloudFormation stack. **Trade-off:** the orchestrator's CodeBuild role is admin-equivalent because the deploy creates essentially the whole account footprint (VPC/EKS/MSK/IAM/IoT/Firehose/S3) — the same blast radius as a facilitator's own credentials; tightening to least-privilege is follow-up work. |
| RisingWave-compute node group scope ([#211](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/issues/211)) | One shared `rw-compute` managed node group (`r6i.xlarge`) for the whole cluster, not one per slot | The freshness/clock-skew bug (#206) was CPU starvation from sharing a **burstable** `t3.medium` with unrelated pods — a *class of instance* problem, not a cross-slot isolation problem. The taint (`dedicated=risingwave-compute:NoSchedule`) already keeps every non-RW-compute pod off these nodes regardless of how many slots' compute pods land there, so per-slot node groups would multiply the (non-trivial, memory-optimized) `r6i.xlarge` cost by the slot count for no additional freshness benefit. **Accepted trade-off:** the pool scales via `scalingConfig` (`min:1/desired:1/max:8`, matching `workshop-nodes`), but there is no cluster-autoscaler wired up, so scaling out to more concurrent slots than fit on the current node count means manually bumping `desiredSize` — same limitation `workshop-nodes` already has, not new to this change. |

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
