# Block 3 — Digital Ops Metrics + Network Failure Simulation

**Duration:** 60 min

---

## Navigate to the Digital Ops View

The Digital Ops View shows operational metrics for data engineers:

- **WAN relay lag** — Redpanda consumer group offset lag (messages in Redpanda not yet forwarded to cloud MSK)
- **Edge buffer utilization** — Redpanda NVMe usage %
- **Queue depth** — messages buffered at edge not yet uploaded to cloud
- **RisingWave MV freshness** — lag from Redpanda to materialized view output

All metrics should read near-zero when the network is healthy.

---

## Simulate a Network Failure

1. **Use the EC2 console** to modify the edge subnet's route table — remove the IGW route (simulates WAN link down)

2. **Observe in the Digital Ops View:**
   - WAN relay lag counter starts climbing
   - Queue depth increases as sensor data accumulates in Redpanda
   - **Site View continues updating normally** — the HMI is running fully local against Edge RisingWave

3. **Discuss:** This is the resilience story. The edge-local dashboard continues with no cloud connectivity. Redpanda durably buffers all data.

4. **Restore the IGW route** in the EC2 console

5. **Observe recovery:**
   - WAN relay resumes automatically from the committed Kafka offset
   - Queue depth returns to zero
   - No data was lost — Redpanda's offset model guarantees exactly-once delivery on reconnect

---

## Discussion

- What would happen in a traditional architecture where edge devices write directly to cloud storage?
- Why is Redpanda's Kafka-compatible offset model important for this resilience story?
- How would you alert on growing queue depth in a production deployment?

---

## Reference

- [Redpanda Connect WAN relay](https://docs.redpanda.com/redpanda-connect/)
