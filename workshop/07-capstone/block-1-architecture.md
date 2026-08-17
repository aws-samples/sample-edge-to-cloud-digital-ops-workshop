# Block 1 — Architecture Walkthrough

**Duration:** 60 min

---

## Facilitator-Led Walkthrough

Walk through the complete data flow using the architecture diagram from [docs/notes/real-time-pipeline-architecture.md](../reference/architecture.md). For each component, discuss:

- What it does in the workshop vs what it does in production
- What changes when moving to real edge hardware (RKE2 vs K3s, Redpanda Enterprise vs CE, real sensors vs Python simulator)
- HA model: what happens when a node fails at the edge vs in the cloud

---

## Component-by-Component

| Component | Workshop | Production change |
|---|---|---|
| Edge K8s | K3s (fast to bootstrap) | RKE2 (FIPS 140-2 validated) |
| Edge stream buffer | Redpanda Community | Redpanda Enterprise (Tiered Storage, RBAC, FIPS) |
| Sensors | Python simulator on EC2 | Real sensors via OPC-UA or MQTT |
| WAN link | Public internet | Amazon Leo or private MPLS |
| Cloud K8s | EKS `t3.medium` nodes | EKS `m5.2xlarge` + Karpenter autoscaling |
| IoT provisioning | By claim (automated CDK) | By trusted user (field engineer + Cognito) |

---

## Choosing Your AWS Entrypoint: IoT Core vs. MSK

The single most consequential architecture decision is **how telemetry first enters AWS** — because it dictates your throughput ceiling, your offline behaviour, which fleet-management features you get for free, and how tightly coupled the edge is to AWS. This workshop deliberately shows two of the three viable front doors so you can feel the tradeoff:

| | Device → IoT Core | Device → MSK (Kafka producer) | Edge Redpanda → MSK relay |
|---|---|---|---|
| **In this workshop** | Sessions 1–4 | Not built | Sessions 5–7 |
| **Protocol** | MQTT (lightweight, device-friendly) | Kafka wire protocol | MQTT at edge, Kafka over WAN |
| **Managed by AWS** | Fully managed broker | Managed cluster, you run producers | You operate the edge broker |
| **WAN required to publish** | Yes | Yes | No — buffers locally, relays on reconnect |
| **Survives WAN outage** | No — messages dropped | No | Yes — no data loss across outages |
| **Edge-local dashboards** | No | No | Yes — edge RisingWave/TimescaleDB serve locally |
| **Per-connection throughput** | 100 msg/s hard cap | No practical cap | No practical cap |
| **Fleet management** | Native — Jobs, shadows, fleet provisioning, defender | None — build your own | None at the AWS layer |
| **Device auth** | X.509 certs, native fleet provisioning | SASL/SCRAM or mTLS you manage | Edge handles device auth locally |
| **Operational overhead** | Lowest | Medium | Highest — a K8s + Redpanda stack per site |
| **Cloud coupling** | Tightest (AWS-specific) | Kafka-portable | Loosest — Kafka interface, swappable backend |

### When to use IoT Core as the entrypoint

- Devices have **stable, always-on connectivity** and publish at **≤100 msg/s**.
- You want **IoT Jobs, device shadows, fleet provisioning, or Device Defender** — these are IoT Core features with no Kafka equivalent, and rebuilding them is a project of its own.
- You value **lowest operational overhead** and are comfortable with an AWS-specific control plane.

### When to send devices straight to MSK (Kafka producer)

- Devices or site gateways are **already Kafka-native**, or exceed IoT Core's per-connection throughput cap (high-rate vibration/acoustic sensors).
- You want a **Kafka-portable** ingest contract but **don't need edge-local buffering** — the link to AWS is reliable enough that local survival isn't a requirement.
- You're prepared to **own device authentication and connection management** yourself.

### When to use the edge Redpanda → MSK relay

- Sites are **remote or intermittently connected** (offshore rigs, wellsites) and must **lose zero data through a WAN outage**.
- Operators need **live local dashboards that keep working when the cloud link is down**.
- You want the **loosest cloud coupling** — the Kafka interface lets you retarget the backend (MSK today, another Kafka tomorrow) without touching the edge.

!!! tip "These are not mutually exclusive"
    A real fleet often mixes them: stable office sensors go direct to IoT Core for its fleet-management features, while remote high-value sites run the edge relay for resilience. Both land in the **same** MSK cluster and feed the same downstream consumers — the entrypoint is a per-device decision, not a whole-fleet one.
