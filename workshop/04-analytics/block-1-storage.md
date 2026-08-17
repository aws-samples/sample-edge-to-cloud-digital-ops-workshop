# Block 1 — Storage Tiers: In-Memory, On-Disk, and Object-Store

**Duration:** 30 min

---

## Why This Session Has Four Stores

The rest of this session puts the **same** telemetry into several different stores —
RisingWave, TimescaleDB, Timestream for InfluxDB, and Iceberg-on-S3 (queried with
Athena) — and a fifth, database-free path (AppSync live push). That is deliberate:
there is no single "best" store for time-series telemetry, only trade-offs. Before
you query any of them, this block gives you the map — **what each store is, where it
physically serves data from, and how that choice shows up as freshness and query
latency.**

The unifying question the whole session answers: *when a value lands in the pipeline,
how long until a query can return it, and how does that hold as the fleet grows?* The
customer driving this workshop has a hard **2-second end-to-end budget** — from "a
value is written" to "a query returns it" — and every store below either holds that
budget or doesn't, depending on how you use it.

---

## The Three Serving Substrates

Every store here ultimately reads from one of three places. That substrate sets the
**latency floor** — the fastest a read can possibly be — before any query tuning:

| Substrate | Latency floor | Why | Store(s) here |
|---|---|---|---|
| **In-memory** | microseconds → low tens of ms | Result already sits in RAM; a read is a keyed lookup, no scan | RisingWave materialized views |
| **On-disk** | low → tens of ms | Rows/pages on local block storage; hot pages cached in RAM, cold pages faulted in; cost scales with rows scanned | TimescaleDB, Timestream for InfluxDB |
| **Object store** | seconds | Columnar files in S3; every query pays an S3 round-trip + planning, then scans bytes | Iceberg / Athena |

A fourth path — **AppSync live push** — serves from *no* store at all: it forwards the
message in flight over a WebSocket, so it's the freshness ceiling everything else is
measured against (~10–80 ms), with no history and no query engine.

---

## The Stores at a Glance

| Store | Serves from | Model | Best at | Typical freshness |
|---|---|---|---|---|
| **AppSync push** | in-flight message (no store) | Direct WebSocket push | "Tell me the instant a value changes" | ~10–80 ms |
| **RisingWave** | **in-memory** MV state (durable checkpoints spill to S3) | Streaming MV engine — incremental compute | Pre-defined aggregations, always-current, push | ~300–600 ms |
| **TimescaleDB** | **disk** (Postgres hypertables on a PVC) | Relational time-series | Ad-hoc SQL over recent raw rows; range scans | ~1–3 s |
| **Timestream for InfluxDB** | **disk** (AWS-managed instance) | Dimensional time-series (measurement/tags/fields) | The same hot-tier job, fully managed | ~1–2 s |
| **Iceberg / Athena** | **object store** (columnar Parquet in S3) | Query engine over files | Cheap retention of unlimited history; large scans | tens of s → ~300 s |

You'll query each of these directly in Blocks 2–5, then see all four side by side on
the freshness dashboard in [Block 6](block-6-dashboard.md).

---

## Performance Characteristics

Two numbers matter, and they move **independently** — keep them separate in your head
for the rest of the session:

- **Freshness** = `now − MAX(timestamp)` — how *stale* the newest row a store holds is.
  Driven by the **ingestion** path (how fast writes become visible).
- **Query latency** = wall-clock to run the read. Driven by the **read path** — and the
  read path's floor is the serving substrate above (memory vs disk vs object store).

### Read complexity vs. write complexity

The single idea that explains every latency number you'll see: **the aggregation
complexity has to live somewhere — you choose whether to pay it on the write path or the
read path.** RisingWave and TimescaleDB sit at opposite ends of that choice, which is
exactly why the session runs them side by side.

- **RisingWave — complexity at write time.** A streaming operator graph maintains each
  materialized view incrementally as events arrive: every row costs work up front, plus
  the machinery to keep that state correct (checkpoint barriers, compute-node state,
  spill-to-S3). The pay-off is a **trivial read** — a keyed lookup of an already-computed
  result, latency **independent of history size**.
- **TimescaleDB (raw `GROUP BY`) — complexity at read time.** Writes are dead simple
  (just `INSERT`s); nothing is pre-computed. The complexity lands on every query, which
  must **scan and aggregate rows on demand** — latency **grows with data volume** and
  blows the budget once the window × fleet size gets large.

Neither extreme is free, and the choice isn't binary: a **TimescaleDB continuous
aggregate** (Block 4) deliberately shifts complexity *back* toward the write path —
pre-materialising the rollup so the read becomes a flat lookup, just like RisingWave.
Athena sits at the far read-complexity end: nothing is maintained, so every query pays a
full scan-and-aggregate over object storage.

### How each store behaves as the fleet grows

| Store | Read-latency driver | Holds the 2 s budget when… | Falls out of budget when… |
|---|---|---|---|
| **RisingWave** | Fixed distributed-query overhead (planning + compute hop) — **flat with scale** | Always, on read; pressure moves to compute-node sizing + checkpoint cadence | Effectively never on read — budget risk shows up as *freshness* (ingestion/checkpoint lag), not latency |
| **TimescaleDB** | Rows scanned (chunk exclusion is decisive) | Raw reads are **time-bounded** (touch only the newest chunk); known rollups use a **continuous aggregate** | You scan unbounded history — a windowless `GROUP BY` went from ~11 ms to seconds-to-minutes on a large table |
| **Timestream for InfluxDB** | Managed instance sizing + series cardinality | Time-bounded queries over bounded-cardinality series | Same read-time scan pressure as any disk store on wide, unbounded queries |
| **Iceberg / Athena** | S3 round-trip + planning — **seconds floor per query** | Never, for interactive point reads | Any interactive use — it's a retention/backfill/history tier, not a live one |

**The rules that hold the budget at scale:**

1. **Never scan unbounded history on the read path.** Time-bound every raw query and
   materialise every known aggregate.
2. **Match the store to the question:** in-memory MV for always-current pre-defined
   aggregations; disk-backed relational for ad-hoc recent scans; object store for cheap
   deep history — never the reverse.
3. **A live tier showing minutes of "freshness" is an _ingestion_ problem, not a slow
   read** — the newest row it committed really is that old.

The [deep scaling analysis](block-6-dashboard.md#data-store-performance-characteristics)
in Block 6 works these numbers out from 3 devices to 30,000+, with the worked failure
cases. For now, hold the map above and go look at the live comparison.

---

## The Query Behind Every Panel

Before you open the dashboard, know what each panel is showing you. Every tier
answers the **same logical query** — *per site, what is the timestamp of the newest
reading, and what is the fleet's average free CPU/memory?* — so the freshness numbers
you're about to compare are apples-to-apples. In tier-agnostic pseudo-SQL:

```sql
SELECT
  site_id,
  MAX(ingest_ts_ms)          AS latest_ts_ms,     -- freshness basis
  AVG(100.0 - cpu_pct)       AS avg_free_cpu_pct,
  AVG(100.0 - mem_used_pct)  AS avg_free_mem_pct
FROM <the store's telemetry table / MV>
[WHERE recent-window predicate]                    -- TimescaleDB & Athena only
GROUP BY site_id
```

Freshness is then `Date.now() - MAX(latest_ts_ms)`, computed client-side against the
**pod's wall-clock** — never the store's own `now()` ([Block 6's CLI
section](block-6-dashboard.md#cli-read-the-same-numbers) explains why that trap
matters for RisingWave). `ingest_ts_ms` is the IoT-Core **arrival** timestamp
(epoch-ms) in every tier — `ts_ms` in RisingWave/TimescaleDB, `message_timestamp` in
Athena, `_time` in InfluxDB — so clock-skew between edge nodes and the dashboard is
eliminated. Only the table/MV and the recent-window predicate differ per store:

| Tier | Table / MV | Recent-window predicate |
|---|---|---|
| **RisingWave** | `mv_sensor_fleet_latest` (pre-materialised MV) | none — the MV is already collapsed to latest-per-site |
| **TimescaleDB** | `sensor_readings` (raw hypertable) | `partition_time > now() - interval '15 minutes'` (load-bearing: chunk exclusion) |
| **Athena / Iceberg** | `workshop_telemetry.telemetry` | optional `deployment_id=` scope |
| **Timestream for InfluxDB** | `sensor_reading` bucket | `range(start:-15m) \|> last()` (Flux) |

Blocks 2–5 build each tier's version of this query;
[Block 6](block-6-dashboard.md#chart-1-data-freshness-log-scale) shows the exact
SQL/Flux each store runs and the CLI equivalents.

---

## Load the Freshness Dashboard

The dashboard renders all four stores' freshness and query latency side by side. Open
it now and keep it up as you work through the rest of the session — Blocks 2–5 explain
*how* each tier gets the data you're watching update.

It runs in-cluster with no public endpoint, so reach it with `kubectl port-forward`.

1. Point `kubectl` at the shared cluster:

    ```bash
    aws eks update-kubeconfig --region us-east-1 --name workshop-eks
    ```

    !!! info "Namespace-scoped access via IAM"
        If you're a participant without cluster-admin, your operations are scoped to your
        own namespace (`ws-slot00`) via `WorkshopParticipantRole-ws-slot00`. Add
        `--role-arn arn:aws:iam::000000000000:role/WorkshopParticipantRole-ws-slot00` to the
        command above, once your admin has granted your IAM identity `sts:AssumeRole` on
        that role.

2. Start the port-forward on local port `8888` (`3000` is commonly taken by other dev
   servers). This clears any stale forwarder first, so it's safe to re-run:

    ```bash
    # Clear any previous forwarder on 8888 so this is safe to re-run.
    pkill -f "port-forward.*svc/cloud-analytics-dashboard" 2>/dev/null && sleep 1
    kubectl port-forward -n ws-slot00 svc/cloud-analytics-dashboard 8888:3000 > /tmp/dashboard-pf.log 2>&1 &
    DASH_PF_PID=$!
    # Wait for the forward to come up, but bail if it dies (e.g. port in use, RBAC) instead of looping forever.
    for _ in $(seq 30); do
      grep -q "Forwarding from" /tmp/dashboard-pf.log 2>/dev/null && break
      kill -0 "$DASH_PF_PID" 2>/dev/null || { echo "port-forward failed:"; cat /tmp/dashboard-pf.log; break; }
      sleep 1
    done
    curl -sf http://localhost:8888 | head -c 200
    echo "Port-forward running (PID $DASH_PF_PID) — open http://localhost:8888 in your browser."
    ```
    <!-- e2e:assert {"contains": "<"} -->

3. **Open [http://localhost:8888](http://localhost:8888) in your web browser.** You
   should see the four-tier freshness comparison — RisingWave and TimescaleDB updating
   live, Timestream for InfluxDB and Athena on their slower cadences. If a tier shows
   `(mock)` or is empty, its telemetry source isn't live yet — that's expected until
   your edge nodes are running (Session 5).

The port-forward stays up in the background. When you're done, stop it with
`kill "$DASH_PF_PID"`.

---

## References

- [RisingWave streaming SQL](https://docs.risingwave.com/sql/overview)
- [TimescaleDB hypertables](https://docs.timescale.com/use-timescale/latest/hypertables/)
- [Amazon Timestream for InfluxDB](https://docs.aws.amazon.com/timestream/latest/developerguide/timestream-for-influxdb.html)
- [Apache Iceberg on Amazon Athena](https://docs.aws.amazon.com/athena/latest/ug/querying-iceberg.html)
