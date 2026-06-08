# Block 2 — S3 Observation

**Duration:** 45 min

---

## Steps

1. Navigate to **S3 → `workshop-{DEPLOYMENT_ID}/telemetry/`**
2. Observe Parquet files being created by MSK Connect (Hudi Sink Connector)
3. Note the partition structure: `year=/month=/day=/hour=/`
4. Open a file with **S3 Select (Parquet)** to inspect raw records

---

## Discussion Questions

- Why Parquet? What compression and schema benefits does it provide over raw JSON?
- What is Apache Hudi? What is **MoR** (Merge on Read) vs CoW (Copy on Write)?
- Why does MSK Connect write batches rather than one file per message? (Hint: think about S3 object count and small-file overhead in Athena.)

---

## Reference

- [MSK Connect](https://docs.aws.amazon.com/msk/latest/developerguide/msk-connect.html)
