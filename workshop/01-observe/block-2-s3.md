# Block 2 — S3 Observation

**Duration:** 45 min

---

!!! note "What's actually in S3"
    Telemetry lands here via the **IoT Rules Engine → S3 action** (one JSON file per message). The workshop uses this simpler direct-to-S3 path rather than the full MSK → Managed Flink → Iceberg pipeline shown in the architecture overview — that path is introduced conceptually here and deployed in Session 4. The S3 → Athena mechanics are identical either way.

## Steps

1. Navigate to [**S3 → `workshop-platform-000000000000/telemetry/`**](https://s3.console.aws.amazon.com/s3/buckets/workshop-platform-000000000000?prefix=telemetry/)
2. Observe JSON files being created by the IoT Rules Engine (one file per MQTT message)
3. Note the key prefix structure: `telemetry/edge/ws-slot00/{THING_NAME}/telemetry/{timestamp}`
4. Click one file → **Download** to inspect a raw JSON payload

---

## Discussion Questions

- Why might you prefer Parquet + Iceberg over raw JSON at scale? (Hint: compression, schema evolution, query performance.)
- What is Apache Iceberg? How does its snapshot/manifest model differ from a plain Hive table?
- Why would the Flink sink write batched checkpoints rather than one file per message? (Hint: think about S3 object count and small-file overhead in Athena.)

!!! info "The production path"
    In a production deployment, a Managed Flink application reads from the MSK topic and writes Parquet files into an Iceberg table on a checkpoint interval, with time-based partitioning. This gives Athena faster queries, 90–95% compression, and automatic schema evolution. The Glue Data Catalog table's `metadata_location` is updated on every commit — no crawler needed. Sessions 5–7 show the full path.

---

## Reference

- [IoT Rules Engine S3 action](https://docs.aws.amazon.com/iot/latest/developerguide/s3-rule-action.html)
- [MSK Connect](https://docs.aws.amazon.com/msk/latest/developerguide/msk-connect.html)
