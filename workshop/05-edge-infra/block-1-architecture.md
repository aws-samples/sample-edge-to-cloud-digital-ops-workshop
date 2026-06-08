# Block 1 — Edge Stack Architecture Review

**Duration:** 30 min

---

## Architecture Overview

Review the full edge stack from [docs/notes/real-time-pipeline-architecture.md](../reference/architecture.md):

```
Sensor simulator (Python, EC2)
  └─ MQTT ──► Redpanda Connect (ingest bridge)
                    │
              Redpanda (3-node Raft)
                    │
         ┌──────────┴──────────┐
         ▼                     ▼
  Edge RisingWave         TimescaleDB (CNPG)
  (streaming MVs)         (ad-hoc queries)
         │
  Next.js HMI (SSE)
         │
   Browser (port-forward)
                    │
              Redpanda Connect (WAN relay)
                    │
              Cloud MSK ──► Cloud analytics
```

---

## No GraphQL Server at the Edge

The cleanest pattern for the edge HMI:

- **Live sensor data (Site View):** Next.js Route Handlers open a `pg` connection directly to Edge RisingWave, issue a `SUBSCRIBE` cursor, and stream results to the browser as **Server-Sent Events (SSE)**
- **Ad-hoc / historical queries (Digital Ops page):** Next.js Route Handlers connect to TimescaleDB on demand

RisingWave supports the PostgreSQL wire protocol, so `node-postgres` connects directly — no sidecar, no PostGraphile, no extra container.

---

## References

- [RisingWave `SUBSCRIBE` docs](https://risingwavelabs.mintlify.app/delivery/subscription)
- [RisingWave PostgreSQL wire protocol](https://risingwave.com/blog/mcp-streaming-database-connect-ai-agents-risingwave/)
