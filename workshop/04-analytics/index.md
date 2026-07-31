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
| [Block 5](block-5-dashboard.md) | 30 min | Live Analytics Dashboard |
| Wrap-up | 15 min | Recap + preview Sessions 5–7 |

---

## Local Tools

Session 4 is the first session you drive from your own laptop against the shared EKS cluster. Install these clients before you start:

| Tool | Install (macOS) | Install (Linux) | Used for |
|---|---|---|---|
| `kubectl` | `brew install kubectl` | [official docs](https://kubernetes.io/docs/tasks/tools/) | All cluster operations |
| `helm` | `brew install helm` | `curl … get_helm.sh \| bash` | Operator + connector installs (Block 1) |
| `psql` | `brew install libpq && brew link --force libpq` | `apt-get install postgresql-client` | Connecting to RisingWave and TimescaleDB (Blocks 2, 4) |
| `aws` CLI v2 | `brew install awscli` | [official docs](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) | Secrets, MSK brokers, `update-kubeconfig` |

!!! tip "`psql` isn't PostgreSQL"
    You only need the PostgreSQL *client* (`psql`), not a running server. On macOS the `libpq` keg provides it without installing a local database — but if you already run PostgreSQL locally, note the port-5432 caveat in Block 4.

---

## Data Freshness Ladder (End State)

| Tier | Mechanism | Expected freshness |
|---|---|---|
| Live push (IoT → AppSync) | No database — direct WebSocket push | ~10–80 ms |
| RisingWave MV | Incremental streaming compute (50 ms barrier) | ~300–600 ms |
| TimescaleDB (live scan) | Redpanda Connect 1 s batch + direct query | ~1–3 s |
| Iceberg / Athena | Firehose buffering interval + Iceberg commit | ~25–90 s |
