# Block 3 — Data Delivery Patterns & Freshness Comparison

**Duration:** 60 min

---

## The One-Publish, Four-Reads Idea

Every pump emits the *same* MQTT telemetry once. What differs is how that single publish reaches the front end and how fresh it is when it arrives. [Block 1](block-1-storage.md) framed the substrates (in-memory, on-disk, object-store) and the read-vs-write-complexity tradeoff; this block puts them side by side on one screen and asks a sharper question: **for the pump-rate metric, which delivery path wins, and why?**

Two axes stay separate throughout:

- **Freshness** — how old the data is when it lands in the browser. Driven by the *ingestion path* (how many hops, whether a buffer/materialization step sits in the way).
- **Query latency** — how long the read itself takes once triggered. Driven by *read cost* (single-row lookup vs. live scan vs. full object-store scan).

A path can be fresh but slow to query, or fast to query but stale. Pump rate exposes the difference.

---

## Four Data Delivery Patterns

The cloud front end surfaces the same fleet through four patterns across the tiers:

| Panel | Query pattern | Data path | Mechanism | Expected freshness |
|---|---|---|---|---|
| **Live push — raw telemetry** | Per-device raw event, no aggregation | IoT Core → IoT Rules HTTP action → AppSync Events → browser WebSocket | AppSync Events push; bypasses all databases | ~10–80 ms |
| **Pump rate — RisingWave MV** | `SUM(pump_rate_bbl_per_min)`, incrementally maintained | AppSync Event → browser HTTP request → RisingWave MV lookup | Single materialized-view row read per event | ~100–400 ms |
| **Pump rate — TimescaleDB CAGG** | Same sum, CAGG + live scan | AppSync Event → browser HTTP request → TimescaleDB CAGG query | Continuous aggregate + live tail scan per event | ~100 ms–3 s |
| **Iceberg / Athena** | Historical only | Athena — no front-end route | Full scan-and-aggregate over object storage | tens of s up to ~300 s *(Firehose buffering interval)* |

The rows are ordered by how much work sits between the device and the answer: none, a pre-computed row, a partial scan, a full scan.

---

## AppSync Events: the database-free path *and* the clock

AppSync Events is doing two distinct jobs in this architecture, and it helps to name them separately.

**1. It is the freshness ceiling.** The live-push panel goes IoT Core → IoT Rules HTTP action → AppSync Events → browser WebSocket. No database is written or read on the way. Because nothing is stored, nothing can be stale — this is the freshest the data will *ever* be visible in the browser (~10–80 ms), and it is flat regardless of fleet size because the cost is per-message, not per-query. The tradeoff is that it delivers only the raw event: there is no history, no aggregation, nothing to query later.

**2. It is a clock signal for the other tiers.** The aggregate panels (RisingWave, TimescaleDB) do **not** hold a long-lived `LISTEN/NOTIFY` or streaming subscription open to their store. Instead, each AppSync Event that arrives in the browser *triggers a fresh, stateless HTTP read* of the latest aggregate. AppSync Events is the heartbeat; the read is a plain request/response against whichever store the panel represents.

!!! note "Why a clock, not a subscription"
    Using the live push as a trigger keeps every aggregate panel a simple stateless query — no per-panel connection to hold open, no cursor state in the browser. The freshness of the *trigger* is decoupled from the freshness and latency of the *store being read*, which is exactly what makes the side-by-side comparison honest: every store is polled on the same clock, so any difference you see is the store's, not the transport's.

For the mechanics of the RisingWave subscription cursor that backs its own live view, see [Block 2](block-2-risingwave.md); the data-path essence for this comparison is just: **browser receives an AppSync Event → browser issues one HTTP query → store returns the current pump-rate aggregate.**

---

## Read complexity vs. write complexity

The RisingWave-MV and TimescaleDB-CAGG panels compute the **identical** metric — `SUM(pump_rate_bbl_per_min)` across the fleet — yet their latency behaves completely differently as the fleet grows. The reason is *when* each pays the aggregation cost.

- **RisingWave — cost paid at WRITE time.** The materialized view is updated incrementally on every insert. By the time a read arrives, the sum already exists as a single row. The per-event read is a flat single-row lookup, so latency stays flat as the fleet grows — 3 devices or 500, it is still one row.

- **TimescaleDB — cost paid at READ time.** The continuous aggregate covers finalized buckets, but the *un-materialized tail* (rows newer than the last CAGG refresh) must be scanned live on every query. That tail grows with the fleet, so read latency grows with it: at 500 devices the live scan covers ~25,000 rows per refresh.

- **Athena / Iceberg — full scan-and-aggregate at READ time.** No materialization at all; every query scans the relevant objects on S3 and aggregates from scratch. Freshness is additionally gated by the Firehose buffering interval before data even lands as queryable objects.

!!! abstract "The one-sentence takeaway"
    You either pay for aggregation on the way in (RisingWave: flat reads, more ingest work) or on the way out (TimescaleDB live scan / Athena: cheap ingest, reads that scale with data). There is no path that is cheap at both ends — the whole session is about choosing which end to pay at for a given metric.

---

## Production Scale Comparison

| | 3 devices (workshop) | 500 devices (production) |
|---|---|---|
| **Live push (IoT → AppSync)** | ~10–80 ms | ~10–80 ms *(flat — per-message, independent of fleet)* |
| **Pump rate — RisingWave MV** | ~100–400 ms | ~100–400 ms *(flat — single row read always)* |
| **Pump rate — TimescaleDB CAGG** | ~100–600 ms | **~500 ms–3 s** *(live scan over ~25K un-materialized rows)* |
| **Iceberg / Athena** | tens of s up to ~300 s | up to ~300 s *(scan size grows with data volume)* |

!!! tip "Why this matters for pump rate"
    Each wellsite may have 2–6 pumps at 1 Hz. At 500 devices the un-materialized tail the CAGG must scan reaches ~25,000 rows per query refresh, so its query latency climbs while RisingWave's stays flat — because RisingWave already paid that cost incrementally on every insert. The freshness axis and the latency axis diverge here: the CAGG data is not *stale*, it is just *slow to read* at scale. That distinction is the point of putting all four panels on one screen.

---

## What each pattern is best for

| Pattern | Best for | Weak at |
|---|---|---|
| **AppSync Events live push** | Alarms, live gauges, "is it moving right now" — freshest possible, flat cost | No history, no aggregation, no query-after-the-fact |
| **RisingWave MV** | Always-on rollups read at high frequency where read latency must stay flat as the fleet scales | Pays continuous ingest/compute cost even when nobody is reading |
| **TimescaleDB CAGG** | Rich ad-hoc SQL over recent history; cheap ingest; occasional reads | Read latency grows with the un-materialized tail at high fleet counts |
| **Iceberg / Athena** | Cheap, durable long-horizon history; large scans you run rarely | Never fresh; every read is a full scan |

---

## References

- [Block 1 — Storage Tiers](block-1-storage.md)
- [Block 2 — RisingWave](block-2-risingwave.md)
- [Block 4 — TimescaleDB](block-4-timescaledb.md)
- [Block 5 — Timestream / InfluxDB](block-5-timestream-influxdb.md)
- [Block 6 — Freshness Dashboard](block-6-dashboard.md)
