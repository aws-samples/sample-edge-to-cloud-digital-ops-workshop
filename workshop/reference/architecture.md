# Architecture Reference

This page summarizes the full edge-to-cloud pipeline architecture. The source document is [docs/notes/real-time-pipeline-architecture.md](../../docs/notes/real-time-pipeline-architecture.md).

---

## Conceptual Model

Every real-time sensor pipeline is a variation of the same four-layer model:

| Layer | Role | Examples |
|---|---|---|
| Sensor | Generates readings at regular intervals, publishes over MQTT | Field instruments, EC2 simulator |
| Message Broker | Lightweight pub/sub; forwards to streaming service | AWS IoT Core, EMQX |
| Streaming Service | Durable, ordered log; multiple consumers; replay on reconnect | MSK (cloud), Redpanda (edge) |
| In-Memory Store | Materialized views; continuous queries; sub-50 ms latency | RisingWave |
| Disk-Based Store | High-throughput writes; continuous aggregates; compression | TimescaleDB |
| Object Storage | Raw stream archive; unlimited capacity; batch-read | S3 (Hudi MoR) |

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
    ├─► MSK Connect (Hudi Sink) ──► S3 (Hudi MoR) ──► Athena
    │
    ├─► Cloud RisingWave (EKS) ──► ALB SSE ──► Cloud UI
    │
    └─► Cloud TimescaleDB (EKS) ──► ALB SSE ──► Cloud UI

AWS IoT Core
  ← EC2 (IoT Device Client, MQTT)
  → IoT Rules Engine → Kafka action → MSK
  → IoT Rules Engine → HTTP action → AppSync Events → Cloud UI (WebSocket)

Amplify (hosted cloud UI)
  ← AppSync Events (WebSocket — device shadows, live push)
  ← ALB SSE (RisingWave aggregation panels)
  ← ALB SSE (TimescaleDB CAGG panels)
```
