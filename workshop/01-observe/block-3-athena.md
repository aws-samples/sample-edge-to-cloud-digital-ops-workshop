# Block 3 — Athena Data Freshness Query

**Duration:** 60 min

---

## Steps

1. Navigate to **Athena → workgroup `workshop-{DEPLOYMENT_ID}`**
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

4. Observe that freshness is typically **a few seconds** — because IoT Rule → S3 fires per-message with no batching. This is faster than the 30–90 s floor you'd see with MSK Connect, but the cost per query is still high (see discussion below).

!!! note "This is different from the production Hudi path"
    In a production deployment, MSK Connect writes Parquet files with time-based partitioning. The IoT Rule path here writes raw JSON, which Athena can query via a JsonSerDe table. The freshness and cost characteristics differ, but the core concept — Athena is not a live-dashboard tool — holds for both.

---

## Why Can't We Wire This to a Live Dashboard?

Walk through the chain of problems:

**1. Every Athena query is a full S3 scan.**  
Each query scans all JSON files in the prefix. At 1 Hz × 3 devices × a week of data, that's >1.8 million objects. No row-level indexing, no pushdown beyond prefix filtering.

**2. Athena startup overhead is irreducible.**  
Even simple queries incur ~2–5 seconds of planning and DPU startup before the first byte returns. At a 5-second dashboard refresh cadence, you'd be starting a new query before the previous one finishes — and paying per query.

**3. S3 is not a streaming source.**  
IoT Rule writes one S3 object per message. S3 has no change-notification mechanism a browser can subscribe to. You'd have to poll — which amplifies both latency and cost.

!!! info "This is the archive tier"
    Appropriate for compliance, ML training, and historical analysis. Not for operational dashboards. Sessions 3–4 introduce the higher-frequency tiers.

---

## Reference

- [Athena query fundamentals](https://docs.aws.amazon.com/athena/latest/ug/querying.html)
- [Hudi incremental query](https://hudi.apache.org/docs/querying_data#incremental-query) — what you'd see in production with MSK Connect
