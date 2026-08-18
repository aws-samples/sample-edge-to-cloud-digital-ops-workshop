# Block 2 — RisingWave: The In-Memory Streaming MV Store

**Duration:** 30 min

---

## What RisingWave Is Best At

RisingWave is the **write-complexity** end of the trade-off [Block 1](block-1-storage.md)
laid out. It maintains each materialized view *incrementally* as events arrive: a
streaming operator graph does the aggregation work up front, on the write path, and keeps
the result sitting in memory. By the time you query, there is nothing left to compute —
a read is a **trivial keyed lookup of an already-computed result**, so its latency floor
is very low and, crucially, **flat with history size**. A view over a billion ingested
rows reads just as fast as one over a thousand.

That is the opposite of TimescaleDB's raw `GROUP BY` or Athena, which defer all the
aggregation to read time and pay it — growing with data volume — on every query. Use
RisingWave when the aggregation is **known in advance** and you want it **always current**:
latest-value-per-key, rolling windowed averages, the metrics behind a live dashboard.

!!! info "Keep the two axes separate"
    - **Freshness** (`now − MAX(ts)`) is driven by the *ingestion* path — how fast a
      new event reaches the view. RisingWave's freshness risk is checkpoint/ingestion
      lag, never a slow read.
    - **Query latency** is the *read* cost. RisingWave serves from in-memory MV state,
      so its floor is very low and flat regardless of how much history exists.

---

## The Materialized Views

Below is RisingWave's own DDL — the sources it consumes and the views it maintains. The
views are the point: each one names an aggregation that is kept continuously up to date,
so the read side never recomputes it.

??? example "View source — ddl-cloud.sql"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/risingwave/ddl-cloud.sql){ .md-button target=_blank }

    ```sql
    --8<-- "risingwave/ddl-cloud.sql"
    ```

| Object | Kind | Purpose |
|---|---|---|
| `sensors_raw_cloud` | Source | Industrial sensor readings from MSK topic `sensors.raw.sim` |
| `sensors_raw_telemetry` | Source | EC2 node telemetry (cpu/mem/disk/net) from MSK topic `raw.telemetry` |
| `mv_sensor_fleet_latest` | Materialized view | Latest reading per sensor per site, across both sources — grouped by `deployment_id` too, since one shared instance now serves every slot |
| `mv_fleet_1min_avg` | Materialized view | 1-minute tumbling-window averages per sensor per site, also grouped by `deployment_id` |
| `dashboard_freshness_sub` | Subscription | Change feed on `mv_sensor_fleet_latest` — the push path the dashboard consumes (Block 6) |

!!! info "One shared instance, filtered by `deployment_id`"
    RisingWave here is **one shared instance for the whole workshop**, not one per slot —
    it reads the same shared MSK topics every slot publishes to, and every view/MV below
    carries a `deployment_id` column instead of being scoped to a single slot. The
    queries in this block filter on `deployment_id = 'ws-slot00'` so you only see your own
    devices; the dashboard (Block 6) does the same filtering via its `?did=` param.

Each source declares the shape of a Kafka/MSK stream; each `CREATE MATERIALIZED VIEW`
compiles into an operator graph that updates on every arriving row. The cost of the
aggregation is paid there, incrementally — not on your query.

!!! warning "RisingWave streaming-SQL constraints (v2.8.x)"
    These shape how the views above are written — worth knowing before you author your own:

    - `MAX_BY(val, ts)` is not available — use `(array_agg(val ORDER BY ts DESC))[1]`.
    - `TUMBLE(src, proctime(), ...)` is only valid for tables with declared watermarks —
      use integer epoch-bucketing for sources without watermarks.
    - The Kafka topic must exist before `CREATE SOURCE` — wildcard topics are not supported.

---

## Connect and Verify

RisingWave speaks the PostgreSQL wire protocol on **port 4567**, so any `psql` client
works:

```bash
kubectl port-forward -n cloud-analytics svc/risingwave-cloud-frontend 4567:4567 > /tmp/rw-cloud-pf.log 2>&1 &
RW_PF_PID=$!
until grep -q "Forwarding from" /tmp/rw-cloud-pf.log 2>/dev/null; do sleep 1; done
psql -h localhost -p 4567 -U root -d dev -c "SHOW MATERIALIZED VIEWS;"
kill "$RW_PF_PID" 2>/dev/null || true
```
<!-- e2e:assert {"contains": "mv_sensor_fleet_latest"} -->

Or leave the port-forward running in another terminal and connect interactively with
`psql -h localhost -p 4567 -U root -d dev`.

---

## Query the Views

Once your edge nodes are running (Session 5), messages appear in the views within seconds.
The shared instance holds every slot's rows, so filter on `deployment_id` to see only
your own devices:

```sql
-- Poll for incoming messages — this source has no deployment_id column yet
-- (it's derived downstream, see sim_all_slots in ddl-cloud.sql), so LIMIT and
-- eyeball your own site_id (ws-slot00-sim) among everyone else's.
SELECT sensor, site_id, value, unit FROM sensors_raw_cloud LIMIT 10;

-- Latest reading per sensor per site — your slot only
SELECT sensor, site_id, round(value::numeric, 2) AS value, unit
FROM mv_sensor_fleet_latest
WHERE deployment_id = 'ws-slot00'
ORDER BY sensor;

-- 1-minute bucket averages — your slot only
SELECT sensor, site_id, round(avg_value::numeric, 2) AS avg_v,
       sample_count, window_start
FROM mv_fleet_1min_avg
WHERE deployment_id = 'ws-slot00'
ORDER BY sensor, window_start DESC;
```

Query the views and observe **sub-100 ms response times** — and notice they stay that
fast whether the fleet has been running for a minute or a month.

!!! info "Why is the MV always fast?"
    RisingWave already did the aggregation on the write path. Each new row updates the
    view's state in memory through its operator graph — nothing is recomputed from
    scratch at query time. So the read is a single keyed lookup into an
    already-materialized result: **read cost is independent of fleet size and history
    depth.** This is the payoff for paying aggregation complexity at ingest time.

---

## The Subscription Behind the Push Path

Because the view is always current, you don't have to poll it — RisingWave can *push*
each change to you. `dashboard_freshness_sub` is a subscription: a change feed over the
same pg wire protocol, no Kafka topic and no extra broker involved.

```sql
DECLARE dashboard_freshness_cur SUBSCRIPTION CURSOR FOR dashboard_freshness_sub;
FETCH 10 FROM dashboard_freshness_cur;
CLOSE dashboard_freshness_cur;
```

Each `FETCH` returns the rows of `mv_sensor_fleet_latest` that changed since the last
fetch. The dashboard's server-side route holds one long-lived connection doing exactly
this in a loop and forwards each change to the browser over SSE — the live-push tier you
compare against the others in [Block 6](block-6-dashboard.md).

---

## Reference

- [RisingWave streaming SQL](https://docs.risingwave.com/sql/overview)
- [RisingWave subscriptions](https://docs.risingwave.com/serve/subscription)
