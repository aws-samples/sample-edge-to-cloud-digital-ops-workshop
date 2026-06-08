# Edge Digital Operations Workshop

**Format:** 4-hour sessions · Once per week · 7 weeks  
**Audience:** Engineers familiar with the AWS console and basic Linux  
**Prerequisite:** A cloud admin deploys the platform stack before Session 1

---

## What You'll Build

By the end of this workshop you will have operated a complete edge-to-cloud industrial data pipeline:

- **3 IoT edge devices** (EC2 instances) publishing OS and sensor metrics through AWS IoT Core
- **A Kafka pipeline** (MSK) routing telemetry to a Hudi data lake on S3
- **Cloud analytics** with RisingWave materialized views and TimescaleDB continuous aggregates
- **A Kubernetes edge stack** (K3s) running Redpanda, RisingWave, and a Next.js HMI
- **A simulated industrial site** with a live P&ID-style operator dashboard

---

## Architecture Overview

```
Edge EC2 instances (IoT Device Client)
  └─ MQTT ──► AWS IoT Core ──► IoT Rules Engine
                                    │
                              Kafka action
                                    │
                              Amazon MSK ──► MSK Connect ──► Hudi/S3 ──► Athena
                                    │
                              Cloud RisingWave (EKS) ──► AppSync Events ──► Browser
                              Cloud TimescaleDB (EKS) ──► ALB SSE ──► Browser

Edge K3s Cluster (Session 5+)
  └─ Sensor simulator ──► Redpanda ──► Edge RisingWave ──► Next.js HMI (SSE)
                               └──► Redpanda Connect WAN relay ──► MSK
```

---

## Session Map

| # | Session | Goal |
|---|---------|------|
| Pre | [Admin Setup](00-prerequisites/index.md) | Deploy the platform stack |
| 1 | [Observe — The Data in Motion](01-observe/index.md) | IoT Core → MSK → S3 → Athena |
| 2 | [Control — Fleet Management](02-control/index.md) | IoT Jobs, device update, fleet indexing |
| 3 | [State — Device Shadows & UI](03-state/index.md) | Named shadows, Amplify front end, failure detection |
| 4 | [Analytics — Cloud Telemetry](04-analytics/index.md) | RisingWave MVs, TimescaleDB CAGGs, freshness comparison |
| 5 | [Edge Infrastructure — K3s](05-edge-infra/index.md) | K3s cluster via IoT Job, Helm edge stack |
| 6 | [HMI — Edge Operator Interface](06-hmi/index.md) | P&ID site view, Digital Ops metrics, network failure |
| 7 | [Capstone — Production Path](07-capstone/index.md) | Architecture review, fleet scale, Day-2 ops, teardown |

---

## Key Data Freshness Reference

| Storage tier | Mechanism | Expected freshness |
|---|---|---|
| Live push (IoT → AppSync) | No database — direct WebSocket push | ~10–80 ms |
| RisingWave MV | Incremental streaming compute | ~100–400 ms |
| TimescaleDB CAGG | Batch materialize + live scan | ~100 ms–3 s (scales with fleet size) |
| Hudi / Athena | MSK Connect flush + Hudi delta log | ~30–90 s |

---

## Before You Begin

Check that you have received your **`DEPLOYMENT_ID`** (format: `ws-a1b2c3`) from the workshop facilitator. You will substitute this value wherever you see `{DEPLOYMENT_ID}` in the instructions.
