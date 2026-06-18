# IoT Telemetry → MSK → All Cloud Stores: Implementation Progress

## Goal

Route IoT node telemetry (`cpu_pct`, `mem_used_pct`, `disk_used_pct`, `net_io_bytes_sent`, `net_io_bytes_recv`) through MSK so that all three cloud data stores — Athena/S3 datalake, cloud TimescaleDB, and cloud RisingWave — contain the same dataset. This enables an apples-to-apples data freshness comparison in Phase 5 (Session 4 / cloud analytics) of the e2e test suite, without requiring live IoT edge deployment.

---

## Architecture

```
EC2 edge nodes
    │  MQTT
    ▼
AWS IoT Core  ──rule: IotToMskRule──►  MSK  raw.telemetry
                 (native Kafka VPC action)         │
                                                   ├──► RisingWave (sensors_raw_telemetry source)
                                                   │       └── mv_sensor_fleet_latest (UNION ALL with sensors.raw.sim)
                                                   │       └── mv_fleet_1min_avg
                                                   │
                                                   └──► rp-connect-timescaledb (Redpanda Connect)
                                                           └── TimescaleDB sensor_readings table

MSK  sensors.raw.sim  (existing industrial simulator)
    ├──► RisingWave (sensors_raw_cloud source — existing)
    └──► rp-connect-timescaledb (same consumer — routing by field presence)

Athena/S3 datalake  ◄── IoT S3 rule (unchanged, existing path)
```

**Freshness ladder verified:** RisingWave (~1.7s) < TimescaleDB (~3.4s) < Athena/S3 (~30s)

---

## Completed Work

### 1. CDK: Replace Lambda bridge with native IoT Kafka VPC action

**File:** `amplify/custom/participant-stack.ts`

- Removed `mskBridgeRole` IAM role and Lambda function (`mskBridgeFn`)
- Removed `AllowIoTInvokeMsk` Lambda permission
- Added `IotKafkaVpcRole` with EC2 network interface + SecretsManager + KMS permissions
- Added `KafkaVpcDest` (`CfnTopicRuleDestination`) pointing at the private VPC subnet
- Updated `IotToMskRule` to use the native `kafka` action with SASL/SCRAM auth via IoT substitution templates (`${get_secret(...)}`)
- `mskCredSecret` and `mskAssociateScram` retained — still needed by downstream sinks

### 2. Deleted Lambda source

Removed `amplify/lambda/msk-bridge/` directory entirely.

### 3. rp-connect-timescaledb: consume raw.telemetry + unpivot

**File:** `helm/rp-connect-timescaledb.yaml`

- Added `raw.telemetry` to the Kafka topics list (alongside `^sensors\.raw\.`)
- Added `switch` processor routing on field presence (`this.exists("thing_name")`)
  - IoT node messages: `unarchive: json_array` after expanding into 5 sensor rows per message
  - Industrial sensor messages: pass through unchanged
- Null-safe value coercion: `(this.field | 0).number()` handles null fields in raw.telemetry

### 4. RisingWave DDL: add raw.telemetry source + UNION ALL views

**File:** `risingwave/ddl-cloud.sql`

- Added `sensors_raw_telemetry` Kafka source (columns: `thing_name`, `cpu_pct`, `mem_used_pct`, `disk_used_pct`, `net_io_bytes_sent`, `net_io_bytes_recv`, `message_timestamp`)
- Updated `mv_sensor_fleet_latest` and `mv_fleet_1min_avg` to `UNION ALL` both sources
- e2e DDL apply uses drop-and-recreate preamble (`query_timeout: 30_000`) to handle stale materialized views

### 5. e2e runner: Phase 5 freshness comparison + infrastructure

**File:** `e2e/runner.ts`

Key additions inside Phase 5:

- **MSK topic pre-creation**: base64-encoded Python script (`kafka-python-ng`) creates `sensors.raw.sim` and `raw.telemetry` via an ephemeral `kubectl run` pod; polls until both topics confirm available
- **RisingWave pod restart** after clearing S3 state bucket — prevents DROP MV from blocking on checkpoint flush to empty S3
- **Drop-and-recreate DDL preamble** for RisingWave sources and materialized views
- **rp-connect-timescaledb Helm deploy** with TimescaleDB credentials secret
- **TimescaleDB schema init**: idempotent `CREATE TABLE IF NOT EXISTS sensor_readings` (CNPG `postInitSQL` only runs on fresh cluster init)
- **30s data flow wait** before freshness queries
- **Freshness comparison** on three stores:
  - Athena via AWS SDK (`SELECT MAX(ts_ms)...` from Glue-catalogued S3 parquet)
  - RisingWave via `port-forward 14568:4567` (separate from DDL port-forward on 14567)
  - TimescaleDB via CNPG `port-forward`
- **Freshness ladder assertion**: RisingWave < TimescaleDB < Datalake

---

## Key Bugs Fixed During Implementation

| Error | Root Cause | Fix |
|-------|-----------|-----|
| `topic raw.telemetry not found` in RisingWave | MSK topic hadn't been created; `; true` masked pod failure | Rewrote Python script with base64 encoding + explicit while-loop verification |
| `SyntaxError: unexpected character after line continuation` | Python `-c` can't handle indented multiline scripts joined with `\n` | Base64-encode script, run via `exec(__import__('base64').b64decode(...).decode())` |
| `unrecognised method 'double'` in rp-connect | Bloblang has no `.double()` method | Changed to `(field \| 0).number()` |
| `expected number value, got null` in rp-connect | `net_io_bytes_*` can be null in raw.telemetry messages | `(this.net_io_bytes_sent \| 0).number()` with `\| 0` fallback |
| `invalid type 'map[string]interface {}'` in rp-connect | `meta("kafka_topic")` routing unreliable across consumer restarts | Switched to `this.exists("thing_name")` field-presence check |
| RisingWave MV has 0 rows | Old MV created before source existed; `IF NOT EXISTS` blocked recreation | Drop-and-recreate DDL preamble with `query_timeout` |
| DROP MATERIALIZED VIEW blocks indefinitely | S3 state wiped but pods still waited for checkpoint flush | `rollout restart` all RisingWave pods after S3 clear |
| `ECONNREFUSED :14567` (freshness comparison) | Port conflict — DDL phase held 14567, freshness check also tried 14567 | Changed freshness port-forward to 14568 |
| `relation "sensor_readings" does not exist` | CNPG `postInitSQL` doesn't re-run on recycled clusters | Added idempotent `CREATE TABLE IF NOT EXISTS` in test runner |

---

## Final Test Results

**Run date:** 2026-06-18 (UTC)  
**Command:** `pnpm test -- --session analytics --skip-deploy --skip-teardown`

```
Phase 5 — Session 4: Analytics (cloud EKS)
  ✓  workshop-eks API reachable             [2406ms]
  ✓  MSK bootstrap brokers retrieved        [0ms]
  ✓  Cloud namespace has Running pods       [2104ms]   (runningPods=7)
  ✓  Cloud RisingWave mv_sensor_fleet_latest exists and queryable  [150ms]  (rowCount=10)
  ✓  Cloud datalake (Athena) freshness      [78699ms]  (freshnessMs=30191)
  ✓  Cloud RisingWave freshness             [211ms]    (freshnessMs=1688)
  ✓  Cloud TimescaleDB freshness            [117ms]    (freshnessMs=3359)
  ✓  Freshness ladder: RisingWave < TimescaleDB < Datalake
       (rw_ms=1688, tsdb_ms=3359, s3_ms=30191)

Checks passed: 8 / Checks failed: 0
Suite duration: 4.5 min
```

---

## Files Changed

| File | Change |
|------|--------|
| `amplify/custom/participant-stack.ts` | Replaced Lambda bridge with native IoT Kafka VPC action |
| `amplify/lambda/msk-bridge/` | Deleted |
| `helm/rp-connect-timescaledb.yaml` | Added raw.telemetry topic + switch routing + null-safe coercion |
| `risingwave/ddl-cloud.sql` | Added sensors_raw_telemetry source; UNION ALL in both MVs |
| `e2e/runner.ts` | Phase 5: MSK topic init, RisingWave restart, DDL drop-recreate, CNPG schema init, rp-connect deploy, freshness comparison |
