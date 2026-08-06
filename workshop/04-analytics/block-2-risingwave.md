# Block 2 — RisingWave Materialized Views

**Duration:** 30 min

---

## The DDL Is Already Applied

Block 1's `deploy-cloud-analytics.sh` triggers a post-install Job that ran the DDL below against RisingWave automatically — substituting the MSK bootstrap brokers/credentials from the in-cluster `msk-credentials` Secret, no manual `sed | psql`. This block explains what that DDL created.

??? example "View source — ddl-cloud.sql"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/risingwave/ddl-cloud.sql){ .md-button target=_blank }

    ```sql
    --8<-- "risingwave/ddl-cloud.sql"
    ```

| Object | Kind | Purpose |
|---|---|---|
| `sensors_raw_cloud` | Source | Industrial sensor readings from MSK topic `sensors.raw.sim` |
| `sensors_raw_telemetry` | Source | EC2 node telemetry (cpu/mem/disk/net) from MSK topic `raw.telemetry` |
| `mv_sensor_fleet_latest` | Materialized view | Latest reading per sensor per site, across both sources |
| `mv_fleet_1min_avg` | Materialized view | 1-minute tumbling-window averages per sensor per site |
| `dashboard_freshness_sub` | Subscription | Change feed on `mv_sensor_fleet_latest` — the push path the dashboard's `/api/stream/risingwave` route consumes (Block 5) |

!!! warning "RisingWave function compatibility (v2.8.x)"
    - `MAX_BY(val, ts)` is not available — use `(array_agg(val ORDER BY ts DESC))[1]`
    - `TUMBLE(src, proctime(), ...)` is only valid for tables with declared watermarks — use integer epoch-bucketing for sources without watermarks
    - The Kafka topic must exist before `CREATE SOURCE` — wildcard topics are not supported

---

## Connect and Verify

RisingWave's PostgreSQL wire protocol listens on **port 4567** (not 4560, which is the HTTP dashboard):

```bash
kubectl port-forward -n ws-slot00 svc/risingwave-cloud-frontend 4567:4567 > /tmp/rw-cloud-pf.log 2>&1 &
RW_PF_PID=$!
until grep -q "Forwarding from" /tmp/rw-cloud-pf.log 2>/dev/null; do sleep 1; done
psql -h localhost -p 4567 -U root -d dev -c "SHOW MATERIALIZED VIEWS;"
kill "$RW_PF_PID" 2>/dev/null || true
```
<!-- e2e:assert {"contains": "mv_sensor_fleet_latest"} -->

Or keep the port-forward running in a separate terminal and connect interactively with `psql -h localhost -p 4567 -U root -d dev`.

---

## Query the Views

Once your edge nodes are running (Session 5), messages appear in the views within seconds:

```sql
-- Poll for incoming messages
SELECT sensor, site_id, value, unit FROM sensors_raw_cloud LIMIT 10;

-- Latest reading per sensor per site
SELECT sensor, site_id, round(value::numeric, 2) AS value, unit
FROM mv_sensor_fleet_latest
ORDER BY sensor;

-- 1-minute bucket averages
SELECT sensor, site_id, round(avg_value::numeric, 2) AS avg_v,
       sample_count, window_start
FROM mv_fleet_1min_avg
ORDER BY sensor, window_start DESC;
```

Query the views and observe **sub-100 ms response times**.

!!! info "Why is the MV always fast?"
    RisingWave incrementally maintains each view using a streaming operator graph. On each new row, the aggregation is updated in memory — not recomputed from scratch. Read cost is always a single row lookup regardless of fleet size.

---

## The Subscription Behind the Push Path

`dashboard_freshness_sub` is what lets the dashboard (Block 5) show live updates without polling. RisingWave's subscription cursor is a change feed over the pg wire protocol — no Kafka, no extra broker:

```sql
DECLARE dashboard_freshness_cur SUBSCRIPTION CURSOR FOR dashboard_freshness_sub;
FETCH 10 FROM dashboard_freshness_cur;
CLOSE dashboard_freshness_cur;
```

Each `FETCH` returns any rows of `mv_sensor_fleet_latest` that changed since the last fetch. The dashboard's server-side route holds one long-lived connection doing exactly this in a loop, and forwards each change to the browser over SSE — see Block 5.

---

## Reference

- [RisingWave streaming SQL](https://docs.risingwave.com/sql/overview)
- [RisingWave subscriptions](https://docs.risingwave.com/serve/subscription)
