# Block 1 — Port-Forward and Load the HMI

**Duration:** 30 min

---

## Port-Forward

```bash
kubectl port-forward -n edge svc/hmi 3000:3000
```

Open `http://localhost:3000` in a browser.

---

## Live Data Delivery Architecture

The HMI uses a direct PostgreSQL wire subscription — no GraphQL layer, no polling:

```
Browser
  │  EventSource  →  /api/live-stream  (SSE)
  ▼
Next.js App Router Route Handler
  │  pg connection open to Edge RisingWave
  │  CREATE SUBSCRIPTION s1 ON mv_sensor_latest WITHOUT INITIAL SNAPSHOT
  │  DECLARE CURSOR c1 FOR SUBSCRIPTION s1
  │  loop: FETCH 100 FROM c1 → flush as SSE event
  ▼
Edge RisingWave (in-cluster, LAN)
  ← Redpanda ← Redpanda Connect ← Sensor simulator
```

The browser `EventSource` client receives updates and re-renders the React Flow node that owns that sensor. Effective latency: ~100–300 ms LAN.

---

## References

- [React Flow](https://reactflow.dev/)
- [RisingWave SUBSCRIBE docs](https://risingwavelabs.mintlify.app/delivery/subscription)
