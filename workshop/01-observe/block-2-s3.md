# Block 2 — S3 Observation

**Duration:** 45 min

---

!!! note "What's actually in S3"
    Telemetry lands here via **IoT Rule → Amazon Data Firehose → Iceberg**: Firehose reads the telemetry stream and writes batched **Parquet** files into an Iceberg table on S3, partitioned by `deployment_id` and time. This is the production-shaped path — no custom code, no crawler — and the S3 → Athena query mechanics are what you'll build on in later sessions.

## Steps

1. Navigate to [**S3 → `workshop-platform-000000000000/telemetry/`**](https://s3.console.aws.amazon.com/s3/buckets/workshop-platform-000000000000?prefix=telemetry/)
2. Observe Parquet files being written by Amazon Data Firehose (batched — many messages per file, not one file per message)
3. Note the partitioned key structure: `telemetry/telemetry/data/deployment_id=ws-slot00/year={YYYY}/month={MM}/day={DD}/hour={HH}/{file}.parquet`
4. Click one file → **Download** to inspect a raw Parquet payload (columnar — use a Parquet viewer or `parquet-tools`, not a text editor)

---

## Discussion Questions

- Why might you prefer Parquet + Iceberg over raw JSON at scale? (Hint: compression, schema evolution, query performance.)
- What is Apache Iceberg? What does its snapshot/manifest model buy you over a plain Hive table?
- Why would Firehose write batches rather than one file per message? (Hint: think about S3 object count and small-file overhead in Athena.)

!!! info "The production path"
    An IoT Rule delivers telemetry straight to Amazon Data Firehose, which writes Parquet files into an Iceberg table with time-based partitioning. This gives Athena faster queries, 90–95% compression, and automatic schema evolution. The platform stack creates the Iceberg table in the Glue Data Catalog up front — no crawler needed, and Firehose writes into that existing table rather than registering it on first write. Sessions 5–7 show the full path.

---

## Reference

- [IoT Rules Engine S3 action](https://docs.aws.amazon.com/iot/latest/developerguide/s3-rule-action.html)
- [Firehose Apache Iceberg destination](https://docs.aws.amazon.com/firehose/latest/dev/apache-iceberg-destination.html)
