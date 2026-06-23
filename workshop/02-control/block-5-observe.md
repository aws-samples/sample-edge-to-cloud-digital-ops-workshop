# Block 5 — Observe the Updated Data Flow

**Duration:** 45 min

---

## Steps

1. Return to the **MQTT test client** and observe: metric values now have 3 decimal places (`"cpu_pct": 12.450` instead of `12`).
2. Return to **Athena workgroup `workshop-shared`** — confirm the precision change is visible in the archive:

```sql
SELECT
  thing_name,
  from_unixtime(MAX(ingest_ts) / 1000)  AS latest_edge_ts,
  current_timestamp                      AS query_ts,
  date_diff('second',
    from_unixtime(MAX(ingest_ts) / 1000),
    current_timestamp)                   AS freshness_seconds,
  COUNT(*)                               AS row_count
FROM workshop_telemetry.telemetry
WHERE deployment_id = 'ws-slot00'
GROUP BY thing_name
ORDER BY freshness_seconds DESC;
```

3. Observe that rows added after the job succeeded have decimal-precision values; earlier rows have integers — the Parquet schema widens automatically to `DOUBLE`.

---

## Discussion

- The fleet update happened without SSH, without manual intervention, with per-device status tracking — what does this mean for a fleet of 300 remote sites?
- The freshness is the same as Session 1 — why doesn't the precision change affect Athena latency at all?
- What would you need to change in the pipeline to reduce archive-tier latency for compliance/audit use cases?

---

## Wrap-Up

Recap the IoT Jobs model: job document → rollout config → per-device status lifecycle.

**Preview Session 3:** Next week you'll add device shadows for health and deployment state, then use the front-end UI to observe device state and experience failure detection via shadow staleness.
