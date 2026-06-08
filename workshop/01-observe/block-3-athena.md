# Block 3 — Athena Data Freshness Query

**Duration:** 60 min

---

## Steps

1. Navigate to **Athena → workgroup `workshop-{DEPLOYMENT_ID}`**
2. The Hudi table is auto-registered in the Glue catalog by MSK Connect on first write — no crawler run needed
3. Run the data freshness query:

```sql
SELECT
  thing_name,
  MAX(message_timestamp) AS latest_edge_ts,
  current_timestamp      AS query_ts,
  date_diff('second', MAX(message_timestamp), current_timestamp) AS freshness_seconds
FROM "workshop_{deployment_id}"."telemetry"
GROUP BY thing_name
ORDER BY freshness_seconds DESC;
```

4. Observe that freshness is **30–90 seconds** old (MSK Connect flush interval + Hudi delta log commit)

---

## Why Can't We Wire This to a Live Dashboard?

Walk through the chain of problems:

**1. No browser-native Hudi client.**  
There is no JavaScript library that can read a Hudi table. The entire Hudi ecosystem is JVM (Spark, Flink, Trino) or server-side Python. Any browser path requires a query engine in the middle.

**2. Athena startup overhead is irreducible.**  
Even a simple Hudi query through Athena incurs ~2–5 seconds of query planning and DPU startup before the first byte returns. At a 5-second dashboard refresh cadence, you'd be starting a new query before the previous one finishes — and paying per query.

**3. Hudi MoR read amplification.**  
MoR queries merge base files + delta logs at read time. Without regular async compaction, read amplification grows over time.

!!! info "This is the archive tier"
    Appropriate for compliance, ML training, and historical analysis. Not for operational dashboards. Sessions 3–4 introduce the higher-frequency tiers.

---

## Reference

- [Hudi incremental query](https://hudi.apache.org/docs/querying_data#incremental-query)
