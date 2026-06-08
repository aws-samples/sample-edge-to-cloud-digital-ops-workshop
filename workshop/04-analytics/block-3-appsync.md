# Block 3 — AppSync Resolvers & Data Freshness Comparison

**Duration:** 60 min

---

## Four Data Delivery Patterns

The cloud front end uses four patterns across the tiers:

| Panel | Query pattern | Data path | Mechanism | Expected freshness |
|---|---|---|---|---|
| **Live push — raw telemetry** | Per-device raw event, no aggregation | IoT Core → IoT Rules HTTP action → AppSync Events → browser WebSocket | AppSync Events push; bypasses all databases | ~10–80 ms |
| **Pump rate — RisingWave MV** | `SUM(pump_rate_bbl_per_min)`, incrementally maintained | AppSync Event → browser HTTP request → RisingWave MV lookup | Single MV row read per event | ~100–400 ms |
| **Pump rate — TimescaleDB CAGG** | Same sum, CAGG + live scan | AppSync Event → browser HTTP request → TimescaleDB CAGG query | CAGG + live scan per event | ~100 ms–3 s |
| **Hudi / Athena** | Historical only | Athena console — no front-end route | Console only | ~30–90 s floor |

---

## Why ALB for SSE, Not API Gateway?

API Gateway has a **maximum integration timeout of 300 seconds (5 minutes)** — fundamentally incompatible with long-lived SSE connections. An internet-facing **ALB** supports idle timeouts up to **4,000 seconds** with periodic SSE heartbeat comments (`: ping`) to keep the connection alive.

The live SSE stream runs through its own ALB listener with Cognito JWT authorization at the ALB level — no custom auth middleware in the Route Handler.

---

## RisingWave → SSE Architecture

```
Browser
  │  GET /api/risingwave-stream  (SSE, long-lived)
  ▼
ALB (internet-facing, authenticate-cognito rule)
  ▼
EKS — Next.js App Router Route Handler
  │  pg connection to Cloud RisingWave
  │  CREATE SUBSCRIPTION s1 ON fleet_disk ...
  │  DECLARE CURSOR c1 FOR SUBSCRIPTION s1
  │  loop: FETCH 100 FROM c1 → flush as SSE event
  ▼
Cloud RisingWave ← MSK ← IoT Core ← Edge devices
```

---

## Production Scale Comparison

| | 3 devices (workshop) | 500 devices (production) |
|---|---|---|
| **Live push (IoT → AppSync)** | ~10–80 ms | ~10–80 ms *(flat — per-message, independent of fleet)* |
| **Pump rate — RisingWave MV** | ~100–400 ms | ~100–400 ms *(flat — single row read always)* |
| **Pump rate — TimescaleDB CAGG** | ~100–600 ms | **~500 ms–3 s** *(live scan over ~25K un-materialized rows)* |
| **Hudi / Athena** | ~30–90 s | ~30–120 s *(scan size grows with data volume)* |

!!! tip "Why this matters for pump rate"
    Each wellsite may have 2–6 pumps at 1 Hz. At 500 devices the un-materialized tail the CAGG must scan reaches ~25,000 rows per query refresh. RisingWave's MV cost stays flat because it was updated incrementally on every insert — the freshness cost is paid at write time, not read time.

---

## References

- [API Gateway max timeout (300 s)](https://aws.amazon.com/about-aws/whats-new/2024/06/amazon-api-gateway-integration-timeout-limit-29-seconds/)
- [ALB idle timeout (max 4,000 s)](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html)
