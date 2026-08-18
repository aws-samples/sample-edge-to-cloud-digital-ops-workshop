**Subject:** Edge Digital Operations Workshop — Invitation

---

Hi [Name],

I wanted to share an invitation to participate in the **Edge Digital Operations Workshop** — a 7-session hands-on program we've built for engineers who want to go deep on real-time IoT data pipelines on AWS.

**Format:** 4-hour sessions · Once per week · 7 weeks  
**Audience:** Engineers familiar with the AWS console and basic Linux

---

### The Core Idea: A Four-Layer Pipeline

Every real-time sensor pipeline — regardless of cloud provider, on-premises or edge — is a variation of the same four-layer model:

| Layer | Role | Examples |
|---|---|---|
| **Message Broker** | Lightweight pub/sub; accepts MQTT from devices; not a durable log | AWS IoT Core, EMQX |
| **Streaming Service** | Durable, ordered log; multiple consumers read independently; handles replay on reconnect | Kafka, Redpanda, MSK |
| **In-Memory Store** | Materialized views in RAM; continuous queries run as data arrives; sub-50 ms latency | RisingWave |
| **Disk-Based / Object Store** | Accepts high-throughput writes; compressed time-series history; raw archive for ML & compliance | TimescaleDB, S3 |

These layers solve distinct problems that no single system handles well. The workshop maps real AWS and open-source components onto each layer — and shows that **the pattern stays the same whether the pipeline runs on a rig at the edge or entirely in the cloud**.

---

### What You'll Build

Over 7 sessions, you'll build a complete edge-to-cloud pipeline from scratch:

| # | Session | What you build |
|---|---------|----------------|
| 1 | **Observe** | IoT Core → Firehose → S3 → Athena; measure data freshness end-to-end |
| 2 | **Control** | IoT Jobs, device updates, fleet indexing |
| 3 | **State** | Named device shadows, cloud UI, failure detection |
| 4 | **Analytics** | RisingWave materialized views, TimescaleDB continuous aggregates, freshness comparison |
| 5 | **Edge Infrastructure** | K3s cluster via IoT Job, Helm edge stack (Redpanda, RisingWave, TimescaleDB) |
| 6 | **HMI** | P&ID site view, Digital Ops metrics page, network failure simulation |
| 7 | **Capstone** | Architecture review, fleet scale discussion, Day-2 operations, teardown |

By the end, you'll have hands-on experience with both ingest paths — direct IoT Core for always-connected devices, and the resilient edge Redpanda → MSK relay for intermittently-connected field sites — feeding the same downstream analytics stack.

---

### Who This Is For

This workshop is designed for engineers who are:

- Evaluating or building real-time IoT pipelines on AWS
- Responsible for edge infrastructure at remote or intermittently-connected sites (rigs, wellsites, field equipment)
- Looking to understand the tradeoffs between managed AWS services and open-architecture edge stacks
- Interested in data freshness, offline resilience, and operator-facing tooling

---

I'll follow up with logistics. In the meantime, feel free to reply with any questions about scope or prerequisites.

[Your name]
