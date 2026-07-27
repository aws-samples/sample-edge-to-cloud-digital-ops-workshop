# Block 3 — Digital Ops Metrics + Network Failure Simulation

**Duration:** 60 min

---

## Navigate to the Digital Ops View

Open the HMI and click **Digital Ops** (or go to `/ops`). It polls every 30 s and
shows operational metrics for data engineers:

- **Sensor statistics** — per-sensor avg/min/max/count over the last 5 minutes, read directly from the edge TimescaleDB.
- **WAN Relay Backlog** — the number of records buffered on the edge that the relay has not yet forwarded to cloud MSK, derived from the Redpanda consumer-group offset lag.

With the network healthy the backlog reads **0 (Caught up)**: the relay commits
offsets as fast as the simulator ingests.

### How the backlog is measured

The edge → cloud relay is a Redpanda Connect `kafka_franz` consumer group,
`relay-group-<deploymentId>`, reading `sensors.raw.sim` from the edge Redpanda
and writing to cloud MSK. Redpanda publishes each consumer group's per-partition
offsets on its Admin API's Prometheus endpoint (`:9644/public_metrics`). There is
no pre-computed lag metric, so the HMI route derives it as
`log_end_offset − committed_offset`, summed across partitions:

```
backlog = Σ over partitions ( log_end_offset − committed_offset )
```

When the WAN link drops, the relay stops committing offsets while the edge keeps
ingesting — so `log_end_offset` climbs and `committed_offset` freezes, and the
backlog grows. On reconnect the relay resumes from its last commit and the
backlog drains back to zero. No pre-computed metric or extra exporter is needed —
just an HTTP scrape of the metrics the broker already exposes.

??? example "View source — HMI relay-lag route (`hmi/src/app/api/relay-lag/route.ts`)"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/hmi/src/app/api/relay-lag/route.ts){ .md-button target=_blank }

    ```typescript
    --8<-- "hmi/src/app/api/relay-lag/route.ts:relay-lag-route"
    ```

---

## Simulate a Network Failure

1. **Use the EC2 console** to modify the edge subnet's route table — remove the NAT gateway route (simulates WAN link down)

2. **Observe in the Digital Ops View:**
   - **WAN Relay Backlog** climbs from 0 and its status flips to *Backlog draining / WAN degraded* — sensor data is accumulating in Redpanda faster than the stalled relay can forward it.
   - **Site View continues updating normally** — the HMI is running fully local against Edge RisingWave.
   - **Sensor statistics** keep updating — the edge TimescaleDB is unaffected by the cloud outage.

3. **Discuss:** This is the resilience story. The edge-local dashboard continues with no cloud connectivity. Redpanda durably buffers all data.

4. **Restore the NAT gateway route** in the EC2 console

5. **Observe recovery:**
   - The relay resumes automatically from its last committed Kafka offset.
   - The **WAN Relay Backlog** drains back to 0 and its status returns to *Caught up*.
   - No data was lost — Redpanda's offset model guarantees exactly-once delivery on reconnect.

---

## Discussion

- What would happen in a traditional architecture where edge devices write directly to cloud storage?
- Why is Redpanda's Kafka-compatible offset model important for this resilience story?
- How would you alert on growing queue depth in a production deployment?

---

## Reference

- [Redpanda Connect WAN relay](https://docs.redpanda.com/redpanda-connect/)
