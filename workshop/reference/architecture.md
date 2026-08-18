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

```mermaid
flowchart TD
  subgraph Edge["Edge — K3s"]
    Sensor["Sensor simulator"]
    MQTT["MQTT Broker<br/>(Redpanda Connect ingest)"]
    Redpanda["Redpanda<br/>(3-node Raft)"]
    EdgeRW["Edge RisingWave<br/>(streaming MVs)"]
    EdgeTS["Edge TimescaleDB<br/>(ad-hoc queries)"]
    HMI["Next.js HMI (SSE)"]
    EdgeBrowser["Browser"]
    WAN["Redpanda Connect<br/>(WAN relay)"]

    Sensor -->|MQTT| MQTT --> Redpanda
    Redpanda --> EdgeRW
    Redpanda --> EdgeTS
    Redpanda --> WAN
    EdgeRW --> HMI
    EdgeBrowser -->|port-forward| HMI
  end

  subgraph IoT["AWS IoT Core"]
    EC2["EC2 (IoT Device Client, MQTT)"]
    Rules["IoT Rules Engine"]
    EC2 -->|MQTT| Rules
  end

  subgraph Cloud["Cloud — AWS"]
    MSK["Amazon MSK<br/>(Provisioned, SASL/SCRAM)"]
    CloudRW["Cloud RisingWave (EKS)"]
    CloudRC["Redpanda Connect"]
    CloudTS["Cloud TimescaleDB<br/>(EKS, self-managed)"]
    Telegraf["Telegraf (EKS)"]
    Influx["Timestream for InfluxDB<br/>(managed hot tier)"]
    Firehose["Amazon Data Firehose<br/>(Iceberg destination)"]
    S3["S3 (Apache Iceberg)"]
    Athena["Athena"]
    AppSync["AppSync Events"]
    UI["Cloud UI (EKS)<br/>(served via ALB)"]

    MSK --> CloudRW -->|ALB SSE| UI
    MSK --> CloudRC --> CloudTS -->|ALB SSE| UI
    MSK --> Telegraf --> Influx -->|HTTP poll| UI
    Firehose --> S3 --> Athena
    AppSync -->|WebSocket| UI
  end

  WAN --> MSK
  Rules -->|Kafka action| MSK
  Rules -->|Firehose action, no MSK hop| Firehose
  Rules -->|HTTP action| AppSync
```
