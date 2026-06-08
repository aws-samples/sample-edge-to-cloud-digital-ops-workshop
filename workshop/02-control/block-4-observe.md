# Block 4 — Observe the Updated Data Flow

**Duration:** 45 min

---

## Steps

1. Return to **S3 → `workshop-{DEPLOYMENT_ID}/telemetry/`** — new metrics now appearing in the Parquet files
2. Return to **Athena** — run the updated freshness query

```sql
SELECT
  thing_name,
  MAX(message_timestamp) AS latest_edge_ts,
  current_timestamp      AS query_ts,
  date_diff('second', MAX(message_timestamp), current_timestamp) AS freshness_seconds,
  COUNT(*) AS row_count
FROM "workshop_{deployment_id}"."telemetry"
GROUP BY thing_name
ORDER BY freshness_seconds DESC;
```

3. Observe: **5× more data points per minute** compared to Session 1
4. Confirm new metrics `net_io_bytes_sent` / `net_io_bytes_recv` appear in query results

---

## Discussion

- The fleet update happened without SSH, without manual intervention, with per-device status tracking — what does this mean for a fleet of 300 remote sites?
- The freshness is still 30–90 seconds. Why hasn't it improved even though data arrives 5× faster?
- What would you need to change in the pipeline to reduce archive-tier freshness?

---

## Wrap-Up

Recap the IoT Jobs model: job document → rollout config → per-device status lifecycle.

**Preview Session 3:** Next week you'll add device shadows for health and deployment state, then use the front-end UI to observe device state and experience failure detection via shadow staleness.
