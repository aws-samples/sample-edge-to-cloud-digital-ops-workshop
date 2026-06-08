# Session 4 — Analytics: Cloud Telemetry Plane

**Duration:** 4 hours  
**Goal:** Deploy RisingWave and TimescaleDB into the cloud EKS cluster, wire them to MSK, and compare live data freshness across three storage tiers.

---

## Session Overview

| Block | Duration | Topic |
|---|---|---|
| [Block 1](block-1-deploy.md) | 45 min | Deploy Cloud Analytics Stack |
| [Block 2](block-2-risingwave.md) | 45 min | Create RisingWave Materialized Views |
| [Block 3](block-3-appsync.md) | 60 min | AppSync Resolvers & Data Freshness Comparison |
| [Block 4](block-4-timescaledb.md) | 45 min | TimescaleDB Continuous Aggregates |
| Wrap-up | 15 min | Recap + preview Sessions 5–7 |

---

## Data Freshness Ladder (End State)

| Tier | Mechanism | Expected freshness |
|---|---|---|
| Live push (IoT → AppSync) | No database — direct WebSocket push | ~10–80 ms |
| RisingWave MV | Incremental streaming compute | ~100–400 ms |
| TimescaleDB CAGG | Batch materialize + live scan | ~100 ms–3 s (grows with fleet size) |
| Hudi / Athena | MSK Connect flush + delta log | ~30–90 s |
