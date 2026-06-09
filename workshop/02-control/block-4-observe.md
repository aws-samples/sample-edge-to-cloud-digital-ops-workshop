# Block 4 — Observe the Updated Data Flow

**Duration:** 45 min

---

## Steps

1. Return to **S3 → `workshop-{DEPLOYMENT_ID}/telemetry/`** — messages now arriving at 1 Hz (5× more than Session 1)
2. Return to **Athena workgroup `workshop-{DEPLOYMENT_ID}`** — run the updated freshness query:

```sql
SELECT
  thing_name,
  from_unixtime(MAX(message_timestamp) / 1000) AS latest_edge_ts,
  current_timestamp                             AS query_ts,
  date_diff('second',
    from_unixtime(MAX(message_timestamp) / 1000),
    current_timestamp)                          AS freshness_seconds,
  COUNT(*)                                      AS row_count
FROM "workshop_{DEPLOYMENT_ID}"."telemetry"
GROUP BY thing_name
ORDER BY freshness_seconds DESC;
```

3. Observe: **5× more rows per minute** (1 Hz vs 0.2 Hz)
4. If `net_io_bytes_sent` / `net_io_bytes_recv` columns don't appear, add them to the Glue table:

```sql
ALTER TABLE "workshop_{DEPLOYMENT_ID}"."telemetry"
  ADD COLUMNS (net_io_bytes_sent BIGINT, net_io_bytes_recv BIGINT);
```

---

## Discussion

- The fleet update happened without SSH, without manual intervention, with per-device status tracking — what does this mean for a fleet of 300 remote sites?
- The freshness is still a few seconds (IoT Rule → S3 fires per-message). Why won't this change even if data arrives 5× faster?
- What would you need to change in the pipeline to reduce archive-tier latency for compliance/audit use cases?

---

## Wrap-Up

Recap the IoT Jobs model: job document → rollout config → per-device status lifecycle.

**Preview Session 3:** Next week you'll add device shadows for health and deployment state, then use the front-end UI to observe device state and experience failure detection via shadow staleness.
