# Block 3 — Athena Data Freshness Query

**Duration:** 60 min

---

## Steps

1. Navigate to [**Athena → workgroup `workshop-shared`**](https://console.aws.amazon.com/athena/home#/query-editor?workgroup=workshop-shared)
2. All slots share a single Glue database `workshop_telemetry` pre-created by the platform stack — no DDL needed. Confirm the table exists by running in the query editor:

    ```sql
    SHOW TABLES IN workshop_telemetry;
    ```

    ??? example "AWS CLI equivalent"
        ```bash
        aws glue get-tables \
          --database-name workshop_telemetry \
          --query 'TableList[].Name' --output table
        ```
        <!-- e2e:assert {"contains": "telemetry"} -->

3. Run the data freshness query in the Athena query editor:

    ```sql
    SELECT
      thing_name,
      from_unixtime(MAX(ingest_ts) / 1000)  AS latest_edge_ts,
      current_timestamp                      AS query_ts,
      date_diff('second',
        from_unixtime(MAX(ingest_ts) / 1000),
        current_timestamp)                   AS freshness_seconds
    FROM workshop_telemetry.telemetry
    WHERE deployment_id = 'ws-slot00'
    GROUP BY thing_name
    ORDER BY freshness_seconds ASC;
    ```

    ??? example "AWS CLI equivalent"
        ```bash
        QUERY_ID=$(aws athena start-query-execution \
          --work-group workshop-shared \
          --query-string "SELECT thing_name, from_unixtime(MAX(ingest_ts)/1000) AS latest_edge_ts, current_timestamp AS query_ts, date_diff('second', from_unixtime(MAX(ingest_ts)/1000), current_timestamp) AS freshness_seconds FROM workshop_telemetry.telemetry WHERE deployment_id='ws-slot00' GROUP BY thing_name ORDER BY freshness_seconds ASC" \
          --query QueryExecutionId --output text)

        # Wait for completion
        for _i in $(seq 1 20); do
          STATE=$(aws athena get-query-execution \
            --query-execution-id "$QUERY_ID" \
            --query 'QueryExecution.Status.State' --output text)
          if [ "$STATE" = "SUCCEEDED" ] || [ "$STATE" = "FAILED" ] || [ "$STATE" = "CANCELLED" ]; then
            break
          fi
          sleep 3
        done
        echo "$STATE"

        # Fetch results
        aws athena get-query-results \
          --query-execution-id "$QUERY_ID" \
          --query 'ResultSet.Rows[*].Data[*].VarCharValue' --output table
        ```
        <!-- e2e:assert {"contains": "SUCCEEDED"} -->

4. Observe that freshness is typically **~300 seconds** (Firehose's 5-minute buffering interval), and can run up to ~15 minutes under very low throughput — because data flows IoT Rule → MSK → Iceberg table in S3. Amazon Data Firehose buffers messages and commits Parquet files into the Iceberg table on a timed interval rather than writing one object per MQTT message.

!!! info "Why not a direct IoT Rule → S3 path?"
    A direct IoT Rule → S3 action (one S3 object per message) would yield lower latency but creates millions of tiny files that make Athena scans expensive. The MSK → Firehose → Iceberg path batches writes into time-partitioned Parquet files, which trades a bit of freshness for dramatically lower scan cost.

---

## Why Can't We Wire This to a Live Dashboard?

Walk through the chain of problems:

**1. Every Athena query is a full S3 scan.**  
Each query scans all Parquet files under the Iceberg table's data files. Iceberg's partitioning and file pruning via manifest metadata reduce file count compared to per-message writes, but there is still no row-level indexing and no pushdown beyond partition filtering.

**2. Athena startup overhead is irreducible.**  
Even simple queries incur ~2–5 seconds of planning and DPU startup before the first byte returns. At a 5-second dashboard refresh cadence, you'd be starting a new query before the previous one finishes — and paying per query.

**3. S3 is not a streaming source.**  
Firehose commits files on a buffering interval; there is no change-notification mechanism a browser can subscribe to. You'd have to poll Athena — which amplifies both latency and cost.

!!! info "This is the archive tier"
    Appropriate for compliance, ML training, and historical analysis. Not for operational dashboards. Sessions 3–4 introduce the higher-frequency tiers.

---

## Wrap-Up

Recap the full Session 1 data path:

```
EC2 (IoT Device Client)
  → MQTT publish → IoT Core
  → IoT Rules Engine → Kafka action → MSK
  → Amazon Data Firehose (Iceberg destination) → S3
  → Athena (Glue catalog)
```

**Preview Session 2:** Next you'll use IoT Jobs to push a script update to all 3 devices simultaneously — changing telemetry frequency from 0.2 Hz to 1 Hz and adding network I/O metrics. After the job runs you'll use Fleet Indexing to query device state across your whole deployment.

---

## Reference

- [Athena query fundamentals](https://docs.aws.amazon.com/athena/latest/ug/querying.html)
- [Querying Iceberg tables from Athena](https://docs.aws.amazon.com/athena/latest/ug/querying-iceberg.html) — time-travel and snapshot queries avoid full-table reads
