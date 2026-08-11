# Session 5 — Edge Infrastructure: K3s Cluster Deployment

**Duration:** 4 hours  
**Goal:** Deploy a K3s cluster across the 3 edge EC2 instances using an IoT Job, then deploy the full edge data pipeline via Helm.

!!! info "Before running this session"
    Two manual preparation steps are required:

    1. **Build and push the HMI image** to the K3s nodes (see `hmi/Dockerfile`):
       ```bash
       cd hmi && docker build -t workshop-hmi:latest .
       docker images workshop-hmi:latest
       ```
       <!-- e2e:assert {"contains": "workshop-hmi"} -->

       Then import into K3s on each node, or push to a registry.
    2. **Update `helm/edge-stack-values.yaml`** with the sensor simulator EC2 private IP
       and your MSK bootstrap servers (Block 2 covers how to find these).

---

## Session Overview

| Block | Duration | Topic |
|---|---|---|
| [Block 1](block-1-architecture.md) | 30 min | Edge Stack Architecture Review |
| [Block 2](block-2-k3s-launch.md) | 60 min | Launch K3s Job + Sensor EC2 (parallel) |
| [Block 3](block-3-helm.md) | 60 min | Deploy Edge Helm Stack |
| [Block 4](block-4-verify.md) | 45 min | Verify Edge Data Pipeline |
| [Block 5](block-5-observability.md) | 45 min | Cluster Observability (Prometheus + Grafana + k9s) |
| Wrap-up | 15 min | Recap + preview Session 6 |

---

## Edge Stack Components

| Component | Role |
|---|---|
| Redpanda (3-node Raft) | Edge durable stream buffer; offline replay |
| Redpanda Connect (ingest) | MQTT → Redpanda bridge |
| Edge RisingWave | Streaming compute; materialized views; HMI live data source |
| TimescaleDB (CNPG) | Ad-hoc queries; durable time-series storage |
| MinIO | RisingWave checkpoints; Redpanda Tiered Storage target |
| Next.js HMI | P&ID industrial site visualization; Digital Ops metrics |

!!! note "Parallelism in Block 2"
    Step 5A (K3s cluster via IoT Job) and Step 5B (sensor EC2 deploy) are kicked off in parallel. Both must complete before Block 3.
