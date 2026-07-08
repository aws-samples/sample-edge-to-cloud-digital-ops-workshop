# Block 2 — Create RisingWave Materialized Views

**Duration:** 45 min

---

## Connect to RisingWave

RisingWave's PostgreSQL wire protocol listens on **port 4567** (not 4566, which is the HTTP dashboard).

```bash
# In one terminal — keep this running
kubectl port-forward -n ws-slot00 svc/risingwave-cloud-frontend 4567:4567

# In another terminal — connect with psql
psql -h localhost -p 4567 -U root -d dev
```
<!-- e2e:skip --><!-- long-lived interactive port-forward + psql session across two terminals; not scriptable as a single bash block -->

---

## Create the Kafka Source

The MSK bootstrap servers and credentials are available from your Amplify-deployed secrets:

```bash
# Fetch MSK connection details
MSK_BOOTSTRAP=$(aws kafka get-bootstrap-brokers \
  --cluster-arn $(aws cloudformation list-exports \
    --query "Exports[?Name=='workshop-platform-msk-arn'].Value" \
    --output text) \
  --region us-east-1 \
  --query BootstrapBrokerStringSaslScram --output text)

MSK_USER="workshop-ws-slot00"
MSK_PASS=$(aws secretsmanager get-secret-value \
  --secret-id AmazonMSK_workshop-ws-slot00 \
  --query SecretString --output text | python3 -c 'import sys,json; print(json.load(sys.stdin)["password"])')

# Apply the DDL with values substituted
sed -e "s|__MSK_BOOTSTRAP__|$MSK_BOOTSTRAP|g" \
    -e "s|__MSK_USER__|$MSK_USER|g" \
    -e "s|__MSK_PASS__|$MSK_PASS|g" \
    risingwave/ddl-cloud.sql | psql -h localhost -p 4567 -U root -d dev
```
<!-- e2e:skip --><!-- depends on the background port-forward from the previous (skipped) step being open on localhost:4567 -->

??? example "View source — ddl-cloud.sql"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/risingwave/ddl-cloud.sql){ .md-button target=_blank }

    ```sql
    --8<-- "risingwave/ddl-cloud.sql"
    ```

---

## Verify the Source

After running the DDL, confirm the source and views are created:

```sql
SHOW SOURCES;
SHOW MATERIALIZED VIEWS;
```

Once your edge nodes are running (Session 5), messages will appear in the views within seconds. You can also test now by querying directly:

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

!!! warning "RisingWave function compatibility (v2.8.x)"
    - `MAX_BY(val, ts)` is not available — use `(array_agg(val ORDER BY ts DESC))[1]`
    - `TUMBLE(src, proctime(), ...)` is only valid for tables with declared watermarks — use integer epoch-bucketing for sources without watermarks
    - The Kafka topic must exist before `CREATE SOURCE` — wildcard topics are not supported

---

## Reference

- [RisingWave streaming SQL](https://docs.risingwave.com/sql/overview)
