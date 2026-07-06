package com.workshop;

import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.table.api.EnvironmentSettings;
import org.apache.flink.table.api.bridge.java.StreamTableEnvironment;

/**
 * Reads raw.telemetry JSON from Redpanda (local) or MSK (AWS) and writes to an Apache Hudi
 * MERGE_ON_READ table on S3 / LocalStack.
 *
 * Key AWS Managed Flink requirement (included here for parity):
 *   hoodie.embed.timeline.server = false
 *   https://docs.aws.amazon.com/managed-flink/latest/java/troubleshooting-hudi.html
 *
 * Environment variables (set in docker-compose or Managed Flink app properties):
 *   BOOTSTRAP_SERVERS  Kafka bootstrap, e.g. "redpanda:9092" or MSK IAM endpoint
 *   HUDI_BASE_PATH     s3a:// (local) or s3:// (Managed Flink).
 *                      Local default : s3a://workshop-local/hudi-telemetry
 *                      AWS           : s3://workshop-platform-{ACCOUNT_ID}/hudi-telemetry
 *                      (bucket name available in amplify_outputs.json as custom.sharedBucketName)
 */
public class FlinkHudiSinkJob {

    public static void main(String[] args) throws Exception {
        String bootstrapServers = env("BOOTSTRAP_SERVERS", "redpanda:9092");
        String hudiBasePath     = env("HUDI_BASE_PATH",     "s3a://workshop-local/hudi-telemetry");

        StreamExecutionEnvironment senv = StreamExecutionEnvironment.getExecutionEnvironment();
        senv.enableCheckpointing(60_000);

        EnvironmentSettings settings = EnvironmentSettings.newInstance().inStreamingMode().build();
        StreamTableEnvironment tEnv  = StreamTableEnvironment.create(senv, settings);

        // ── Kafka source ──────────────────────────────────────────────────────────
        // Plain PLAINTEXT for local Redpanda; swap security.protocol + sasl.* for MSK IAM.
        tEnv.executeSql(
            "CREATE TABLE kafka_telemetry (" +
            "  thing_name        STRING," +
            "  message_timestamp BIGINT," +
            "  cpu_pct           INT," +
            "  mem_used_pct      INT," +
            "  disk_used_pct     INT," +
            "  net_io_bytes_sent BIGINT," +
            "  net_io_bytes_recv BIGINT," +
            "  mqtt_topic        STRING," +
            "  ingest_ts         BIGINT" +
            ") WITH (" +
            "  'connector'                    = 'kafka'," +
            "  'topic'                        = 'raw.telemetry'," +
            "  'properties.bootstrap.servers' = '" + bootstrapServers + "'," +
            "  'properties.group.id'          = 'flink-hudi-local'," +
            "  'scan.startup.mode'            = 'earliest-offset'," +
            "  'format'                       = 'json'," +
            "  'json.ignore-parse-errors'     = 'true'" +
            ")"
        );

        // ── Hudi sink ─────────────────────────────────────────────────────────────
        // PRIMARY KEY NOT ENFORCED is required by the Hudi Flink connector to route
        // records through the upsert index path.
        tEnv.executeSql(
            "CREATE TABLE hudi_telemetry (" +
            "  thing_name        STRING," +
            "  message_timestamp BIGINT," +
            "  cpu_pct           INT," +
            "  mem_used_pct      INT," +
            "  disk_used_pct     INT," +
            "  net_io_bytes_sent BIGINT," +
            "  net_io_bytes_recv BIGINT," +
            "  mqtt_topic        STRING," +
            "  ingest_ts         BIGINT," +
            "  PRIMARY KEY (thing_name, message_timestamp) NOT ENFORCED" +
            ") WITH (" +
            "  'connector'                        = 'hudi'," +
            "  'path'                             = '" + hudiBasePath + "'," +
            "  'table.type'                       = 'MERGE_ON_READ'," +
            // Required on AWS Managed Flink: disables embedded timeline server so Hudi
            // syncs metadata directly to S3 instead of over blocked internal network.
            "  'hoodie.embed.timeline.server'     = 'false'," +
            "  'write.precombine.field'           = 'message_timestamp'," +
            "  'write.tasks'                      = '2'," +
            "  'hive_sync.enable'                 = 'false'" +
            ")"
        );

        // ── Pipeline ──────────────────────────────────────────────────────────────
        tEnv.executeSql(
            "INSERT INTO hudi_telemetry SELECT * FROM kafka_telemetry"
        ).await();
    }

    private static String env(String name, String defaultValue) {
        String val = System.getenv(name);
        return (val != null && !val.isBlank()) ? val : defaultValue;
    }
}
