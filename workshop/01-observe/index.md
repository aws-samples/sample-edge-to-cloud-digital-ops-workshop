---
hide:
  - navigation
  - toc
---


# Session 1 — Observe: The Data in Motion

**Duration:** 4 hours  
**Goal:** Understand how devices register into IoT Core, then trace the full data path from EC2 → IoT Core → Firehose → S3 → Athena and measure data freshness.

!!! note "Why IoT Core is the front door here"
    This session sends telemetry into AWS through **AWS IoT Core** — the managed MQTT broker. That's a deliberate architecture choice, not the only one: devices can also be Kafka producers straight into MSK, or publish through an edge Redpanda cluster that relays to MSK (which you'll build in Sessions 5–7). IoT Core wins here because it's fully managed and unlocks the fleet-management features this workshop leans on next — Jobs, device shadows, and fleet provisioning. The full three-way comparison, and how to pick per device, is in the [capstone architecture review](../07-capstone/block-1-architecture.md#choosing-your-aws-entrypoint-iot-core-vs-msk).

---

## The Mental Model: Sensor → Broker → Streaming → Storage

Every real-time sensor pipeline — cloud, on-premises, or edge — is a variation of the same handful of roles. Learn these once and every box in the architecture that follows falls into place. **The colors here carry through to the pipeline diagram below.**

```mermaid
block-beta
  columns 3

  Sensor["📡 Sensor<br/>────────────────────────<br/>Generates readings at regular<br/>intervals (e.g. 1 Hz).<br/>Publishes over MQTT."]:1

  MQTT["📨 Message Broker<br/>────────────────────────<br/>Lightweight pub/sub.<br/>Not a durable log.<br/>Forwards to streaming service.<br/>────────────────────────<br/>e.g. IoT Core, EMQX"]:1

  Stream["🔁 Streaming Service<br/>────────────────────────<br/>Durable, ordered log.<br/>Multiple consumers read<br/>independently. Handles<br/>replay on reconnect.<br/>────────────────────────<br/>e.g. Kafka, Redpanda, MSK"]:1

  Mem["🧠 In-Memory Store<br/>────────────────────────<br/>Materialized views in RAM.<br/>Continuous queries run as<br/>data arrives.<br/>Sub-50 ms latency.<br/>────────────────────────<br/>Use for: live dashboards,<br/>alarms, fleet aggregates<br/>────────────────────────<br/>e.g. RisingWave"]:1

  TSDB["🗄️ Disk-Based Store<br/>────────────────────────<br/>Accepts high-throughput writes.<br/>Continuous aggregates<br/>pre-computed on schedule.<br/>90–95% compression.<br/>────────────────────────<br/>Use for: recent history,<br/>ad-hoc drilldown, SQL joins<br/>────────────────────────<br/>e.g. TimescaleDB, InfluxDB"]:1

  Object["🪣 Object Storage<br/>────────────────────────<br/>Raw stream archived directly.<br/>Unlimited capacity, low cost.<br/>Write-once, batch-read.<br/>────────────────────────<br/>Use for: long-term archive,<br/>ML training, compliance<br/>────────────────────────<br/>e.g. S3"]:1

  style Sensor fill:#FED7AA,stroke:#C2410C,color:#1a1a1a
  style MQTT fill:#FEF08A,stroke:#A16207,color:#1a1a1a
  style Stream fill:#BFDBFE,stroke:#1D4ED8,color:#1a1a1a
  style Mem fill:#E9D5FF,stroke:#6D28D9,color:#1a1a1a
  style TSDB fill:#A5F3FC,stroke:#0E7490,color:#1a1a1a
  style Object fill:#E5E7EB,stroke:#374151,color:#1a1a1a
```

The pattern holds whether the pipeline runs on a rig at the edge or entirely in the cloud — only the specific products change.

---

## The Full Pipeline — Where Session 1 Fits

This is the complete edge-to-cloud pipeline you'll build across all seven sessions, with **every box tinted by its role from the model above** — orange sensors, yellow brokers, blue streaming, purple in-memory stores, cyan disk stores, grey object storage. Supporting glue that isn't one of those roles — connectors, dashboards, and the live-push API — is drawn as dashed white boxes. **Session 1 exercises the bold-outlined path:** EC2 devices publish to AWS IoT Core, an IoT Rule fans telemetry to Amazon Data Firehose, and Firehose lands it as Apache Iceberg files in S3 for Athena to query. The rest — the edge K3s stack, MSK, and the live analytics tiers (RisingWave, TimescaleDB, Timestream for InfluxDB, AppSync) — arrives in later sessions.

On this direct path the **only** component outside AWS is the device itself. In production that's a physical field device; in this workshop it's an EC2 instance running the IoT Device Client, purely because everything here deploys into an AWS account. AWS IoT Core and the Rules Engine are managed AWS services and live in the cloud.

```mermaid
flowchart TD
  subgraph Edge["Edge — K3s (Sessions 5–7)"]
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

  subgraph Field["Field device — outside AWS (Sessions 1–4)"]
    EC2["IoT device<br/>(a physical field device in production;<br/>an EC2 w/ IoT Device Client in this workshop)"]
  end

  subgraph Cloud["Cloud — AWS"]
    IoTCore["AWS IoT Core<br/>(managed MQTT broker)"]
    Rules["IoT Rules Engine"]
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

    IoTCore --> Rules
    MSK --> CloudRW -->|ALB SSE| UI
    MSK --> CloudRC --> CloudTS -->|ALB SSE| UI
    MSK --> Telegraf --> Influx -->|HTTP poll| UI
    Firehose --> S3 --> Athena
    AppSync -->|WebSocket| UI
  end

  EC2 -->|MQTT / TLS| IoTCore
  WAN -->|Kafka over WAN| MSK
  Rules -->|Kafka action| MSK
  Rules -->|Firehose action, no MSK hop| Firehose
  Rules -->|HTTP action| AppSync

  classDef sensor fill:#FED7AA,stroke:#C2410C,color:#1a1a1a;
  classDef broker fill:#FEF08A,stroke:#A16207,color:#1a1a1a;
  classDef streaming fill:#BFDBFE,stroke:#1D4ED8,color:#1a1a1a;
  classDef inmem fill:#E9D5FF,stroke:#6D28D9,color:#1a1a1a;
  classDef tsdb fill:#A5F3FC,stroke:#0E7490,color:#1a1a1a;
  classDef object fill:#E5E7EB,stroke:#374151,color:#1a1a1a;
  classDef neutral fill:#FFFFFF,stroke:#94A3B8,stroke-dasharray:4 3,color:#334155;
  classDef active stroke-width:4px;

  class Sensor,EC2 sensor;
  class MQTT,IoTCore,Rules broker;
  class Redpanda,WAN,MSK,Firehose streaming;
  class EdgeRW,CloudRW inmem;
  class EdgeTS,CloudTS,Influx tsdb;
  class S3,Athena object;
  class HMI,EdgeBrowser,CloudRC,Telegraf,AppSync,UI neutral;
  class EC2,IoTCore,Rules,Firehose,S3,Athena active;
```

---

## Session Overview

| Block | Duration | Topic |
|---|---|---|
| [Block 0](block-0-fleet-provisioning.md) | 45 min | Fleet Provisioning — how devices got into IoT Core |
| [Block 1](block-1-console-tour.md) | 45 min | Orientation & Console Tour — subscribe to live telemetry |
| [Block 2](block-2-s3.md) | 45 min | S3 Observation — Iceberg files written by Firehose |
| [Block 3](block-3-athena.md) | 60 min | Athena Data Freshness Query |
| Wrap-up | 15 min | Recap + preview Session 2 |

---

## What You Need

- Your `DEPLOYMENT_ID` from the facilitator (format: `ws-a1b2c3`)
- AWS console access with the workshop IAM role assumed

---

## Key Takeaway

By the end of this session you will have measured the **data freshness** of the archive tier (Iceberg/Athena: tens of seconds up to ~300 seconds, governed by Firehose's buffering interval) and understood why it cannot serve a live operational dashboard. This sets up the motivation for the higher-frequency tiers introduced in Sessions 3–4.
