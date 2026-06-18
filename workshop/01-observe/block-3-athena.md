# Block 3 — Athena Data Freshness Query

**Duration:** 60 min

---

## Steps

1. Navigate to [**Athena → workgroup `workshop-ws-slot00`**](https://console.aws.amazon.com/athena/home#/query-editor?workgroup=workshop-ws-slot00)
2. The Glue table `workshop_{DEPLOYMENT_ID}.telemetry` was pre-created by the platform stack — no DDL needed. Confirm it exists:

```sql
SHOW TABLES IN "workshop_{DEPLOYMENT_ID}";
```

3. Run the data freshness query:

```sql
SELECT
  thing_name,
  from_unixtime(MAX(message_timestamp) / 1000) AS latest_edge_ts,
  current_timestamp                             AS query_ts,
  date_diff('second',
    from_unixtime(MAX(message_timestamp) / 1000),
    current_timestamp)                          AS freshness_seconds
FROM "workshop_{DEPLOYMENT_ID}"."telemetry"
GROUP BY thing_name
ORDER BY freshness_seconds DESC;
```

4. Observe that freshness is typically **30–90 seconds** — because data flows IoT Rule → MSK → Hudi table in S3. MSK batches messages and the Hudi sink commits Parquet files on a timed interval rather than writing one object per MQTT message.

!!! info "Why not a direct IoT Rule → S3 path?"
    A direct IoT Rule → S3 action (one S3 object per message) would yield lower latency but creates millions of tiny files that make Athena scans expensive. The MSK → Hudi path batches writes into time-partitioned Parquet files, which trades a bit of freshness for dramatically lower scan cost.

---

## Why Can't We Wire This to a Live Dashboard?

Walk through the chain of problems:

**1. Every Athena query is a full S3 scan.**  
Each query scans all Parquet files under the Hudi table prefix. Hudi's time-partitioned layout reduces file count compared to per-message writes, but there is still no row-level indexing and no pushdown beyond partition filtering.

**2. Athena startup overhead is irreducible.**  
Even simple queries incur ~2–5 seconds of planning and DPU startup before the first byte returns. At a 5-second dashboard refresh cadence, you'd be starting a new query before the previous one finishes — and paying per query.

**3. S3 is not a streaming source.**  
The Hudi sink commits files on a batch interval; there is no change-notification mechanism a browser can subscribe to. You'd have to poll Athena — which amplifies both latency and cost.

!!! info "This is the archive tier"
    Appropriate for compliance, ML training, and historical analysis. Not for operational dashboards. Sessions 3–4 introduce the higher-frequency tiers.

---

## Reference

- [Athena query fundamentals](https://docs.aws.amazon.com/athena/latest/ug/querying.html)
- [Hudi incremental query](https://hudi.apache.org/docs/querying_data#incremental-query) — enables time-bounded scans on the Hudi table to avoid full-table reads
