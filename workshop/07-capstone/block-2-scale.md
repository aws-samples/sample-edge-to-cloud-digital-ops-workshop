# Block 2 — Fleet Scale Discussion

**Duration:** 60 min

---

## Scaling the Workshop Architecture

Using the 3-device fleet as a baseline:

### Scaling to 10 Participants

Already handled by the `DEPLOYMENT_ID` namespace model — 30 IoT Things total, all network-isolated, independent MSK clusters per slot.

### Scaling to 300 Production Sites

- **3,000 devices** total (10 per site × 300 sites)
- Single shared MSK cluster with per-site topic namespacing: `edge/{SITE_ID}/{THING_NAME}/telemetry`
- Cloud RisingWave scales horizontally — add compute nodes to the EKS cluster
- Cloud TimescaleDB: move to multi-node with TimescaleDB Distributed or Citus

### Fleet Indexing at Scale

Dynamic Thing Groups enable cohort targeting without listing individual devices:

```
# All devices on firmware 2.x
attributes.firmware_major:2

# All devices in West Texas
attributes.region:west-texas

# Devices with stale heartbeats (candidate for investigation)
shadow.name.device-health.reported.cpu_pct:[90 TO *]
```

### Cost Model

MSK dominates per-slot cost. `kafka.t3.small` × 2 brokers ≈ **$200–250/month per deployment slot**.

At 300 sites with a shared MSK cluster on `kafka.m5.large` × 2 brokers ≈ **$800–1,000/month** total for the streaming layer.

See the full cost breakdown in the [architecture notes](../reference/architecture.md).
