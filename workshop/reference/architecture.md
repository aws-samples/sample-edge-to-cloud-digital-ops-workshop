# Architecture Reference

This page summarizes the full edge-to-cloud pipeline architecture. The source document is [docs/notes/real-time-pipeline-architecture.md](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/docs/notes/real-time-pipeline-architecture.md).

---

## Conceptual Model

Every real-time sensor pipeline is a variation of the same four-layer model:

| Layer | Role | Examples |
|---|---|---|
| Sensor | Generates readings at regular intervals, publishes over MQTT | Field instruments, EC2 simulator |
| Message Broker | Lightweight pub/sub; forwards to streaming service | AWS IoT Core, EMQX |
| Streaming Service | Durable, ordered log; multiple consumers; replay on reconnect | MSK (cloud), Redpanda (edge) |
| In-Memory Store | Materialized views; continuous queries; sub-50 ms latency | RisingWave |
| Disk-Based Store | High-throughput writes; continuous aggregates; compression | TimescaleDB (self-managed), Timestream for InfluxDB (managed) |
| Object Storage | Raw stream archive; unlimited capacity; batch-read | S3 (Apache Iceberg) |

---

## Full Architecture Diagram

```
Edge — K3s / K3s
  Sensor simulator ──► MQTT Broker (Redpanda Connect ingest)
                              │
                        Redpanda (3-node Raft)
                              │
                  ┌───────────┴────────────┐
                  ▼                        ▼
          Edge RisingWave           Edge TimescaleDB
          (streaming MVs)           (ad-hoc queries)
                  │
          Next.js HMI (SSE)
          ← port-forward ← Browser
                              │
                        Redpanda Connect (WAN relay)
                              │
Cloud — AWS
  Amazon MSK (Provisioned, SASL/SCRAM)
    │
    ├─► Cloud RisingWave (EKS) ─────────────► ALB SSE ──► Cloud UI
    │
    ├─► Redpanda Connect ─► Cloud TimescaleDB (EKS, self-managed) ──► ALB SSE ──► Cloud UI
    │
    └─► Telegraf (EKS) ──► Timestream for InfluxDB (managed hot tier) ──► poll ──► Cloud UI

  Amazon Data Firehose (Iceberg destination) ──► S3 (Apache Iceberg) ──► Athena
    ▲ (fed directly by an IoT Rule Firehose action — no MSK hop)

AWS IoT Core
  ← EC2 (IoT Device Client, MQTT)
  → IoT Rules Engine → Kafka action    → MSK
  → IoT Rules Engine → Firehose action → Amazon Data Firehose (Iceberg)
  → IoT Rules Engine → HTTP action     → AppSync Events → Cloud UI (WebSocket)

Amplify (hosted cloud UI)
  ← AppSync Events (WebSocket — device shadows, live push)
  ← ALB SSE (RisingWave aggregation panels)
  ← ALB SSE (TimescaleDB CAGG panels)
  ← HTTP poll (Timestream for InfluxDB freshness panel)
```
