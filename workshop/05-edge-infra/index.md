# Session 5 — Edge Infrastructure: K3s Cluster Deployment

**Duration:** 4 hours  
**Goal:** Deploy a K3s cluster across the 3 edge EC2 instances using an IoT Job, then deploy the full edge data pipeline via Helm.

!!! warning "Session 5 — Work in Progress"
    The following assets are not yet committed to the repository. This session is **conceptual** until they are added:

    - **Sensor simulator EC2** — not in `participant-stack.ts` CDK stack (Block 2, Step 5B)
    - **`helm/edge-stack/`** — Helm umbrella chart (Redpanda, RisingWave, TimescaleDB, MinIO, Next.js HMI) (Block 3)
    - **`helm/edge-stack-values.yaml`** — values file for the above (Block 3)
    - **Next.js HMI app** — source not in repo; referenced as a container image in the Helm chart

    Facilitators: add the Helm chart, sensor simulator CDK construct, and HMI app source before running this session.

---

## Session Overview

| Block | Duration | Topic |
|---|---|---|
| [Block 1](block-1-architecture.md) | 30 min | Edge Stack Architecture Review |
| [Block 2](block-2-k3s-launch.md) | 60 min | Launch K3s Job + Sensor EC2 (parallel) |
| [Block 3](block-3-helm.md) | 60 min | Deploy Edge Helm Stack |
| [Block 4](block-4-verify.md) | 45 min | Verify Edge Data Pipeline |
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
