package com.workshop;

import com.amazonaws.services.kinesisanalytics.runtime.KinesisAnalyticsRuntime;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.table.api.TableSchema;
import org.apache.flink.table.api.bridge.java.StreamTableEnvironment;
import org.apache.flink.types.Row;
import org.apache.hadoop.conf.Configuration;
import org.apache.iceberg.*;
import org.apache.iceberg.aws.glue.GlueCatalog;
import org.apache.iceberg.catalog.Namespace;
import org.apache.iceberg.catalog.TableIdentifier;
import org.apache.iceberg.flink.CatalogLoader;
import org.apache.iceberg.flink.FlinkSchemaUtil;
import org.apache.iceberg.flink.TableLoader;
import org.apache.iceberg.flink.sink.FlinkSink;
import org.apache.iceberg.types.Types;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.Properties;

/**
 * Reads telemetry records from MSK (raw.telemetry) and writes to a shared Apache Iceberg table
 * on S3, partitioned by deployment_id/year/month/day/hour.
 *
 * Uses GlueCatalog so that Glue metadata_location is updated after every Iceberg commit,
 * allowing Athena to query the latest data without manual table re-registration.
 *
 * Uses Iceberg DataStream API (FlinkSink.forRow) to bypass FlinkCatalogFactory SPI.
 * GlueCatalog and S3FileIO are instantiated directly from user code (user classloader).
 *
 * Required application properties (FlinkApplicationProperties group):
 *   BOOTSTRAP_SERVERS  — MSK IAM broker endpoints (comma-separated, port 9098)
 *   S3_BASE_PATH       — s3://bucket/prefix  (Iceberg warehouse root)
 *   GLUE_DB            — Glue database name (e.g. workshop_telemetry)
 *
 * MSK authentication: IAM (SASL_SSL / AWS_MSK_IAM).
 * The Managed Flink execution role must have kafka-cluster:Connect,
 * kafka-cluster:DescribeTopic, and kafka-cluster:ReadData on the cluster.
 * No credentials are stored anywhere — the IAMLoginModule exchanges the
 * task-manager's execution role credentials for a signed SigV4 token.
 */
public class FlinkIcebergSinkJob {

    static final Schema ICEBERG_SCHEMA = new Schema(
        Types.NestedField.required(1,  "thing_name",        Types.StringType.get()),
        Types.NestedField.required(2,  "message_timestamp", Types.LongType.get()),
        Types.NestedField.optional(3,  "cpu_pct",           Types.IntegerType.get()),
        Types.NestedField.optional(4,  "mem_used_pct",      Types.IntegerType.get()),
        Types.NestedField.optional(5,  "disk_used_pct",     Types.IntegerType.get()),
        Types.NestedField.optional(6,  "net_io_bytes_sent", Types.LongType.get()),
        Types.NestedField.optional(7,  "net_io_bytes_recv", Types.LongType.get()),
        Types.NestedField.optional(8,  "mqtt_topic",        Types.StringType.get()),
        Types.NestedField.optional(9,  "ingest_ts",         Types.LongType.get()),
        Types.NestedField.optional(10, "year",              Types.StringType.get()),
        Types.NestedField.optional(11, "month",             Types.StringType.get()),
        Types.NestedField.optional(12, "day",               Types.StringType.get()),
        Types.NestedField.optional(13, "hour",              Types.StringType.get()),
        Types.NestedField.optional(14, "deployment_id",     Types.StringType.get())
    );

    // deployment_id is first so participants can efficiently query their own data
    static final PartitionSpec PARTITION_SPEC = PartitionSpec.builderFor(ICEBERG_SCHEMA)
        .identity("deployment_id")
        .identity("year")
        .identity("month")
        .identity("day")
        .identity("hour")
        .build();

    public static void main(String[] args) throws Exception {
        Map<String, Properties> appProps = KinesisAnalyticsRuntime.getApplicationProperties();
        Properties props = appProps.getOrDefault("FlinkApplicationProperties", new Properties());

        String bootstrapServers = requireProp(props, "BOOTSTRAP_SERVERS");
        String s3BasePath       = requireProp(props, "S3_BASE_PATH");
        String glueDbName       = requireProp(props, "GLUE_DB");

        StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
        env.enableCheckpointing(60_000);

        StreamTableEnvironment tEnv = StreamTableEnvironment.create(env);

        // ── Create/load Iceberg table via GlueCatalog ────────────────────────────
        // GlueCatalog updates Glue's metadata_location after every commit so
        // Athena always sees the latest snapshot without manual table re-registration.
        // GlueCatalog + S3FileIO are from iceberg-aws-bundle (user classloader) —
        // no SPI factory involved, no FlinkCatalogFactory classloader isolation issue.
        Map<String, String> catalogProps = new HashMap<>();
        catalogProps.put("warehouse", s3BasePath);
        catalogProps.put("io-impl", "org.apache.iceberg.aws.s3.S3FileIO");

        Configuration hadoopConf = new Configuration();
        GlueCatalog catalog = new GlueCatalog();
        catalog.initialize("glue_catalog", catalogProps);

        TableIdentifier tableId = TableIdentifier.of(glueDbName, "telemetry");
        if (!catalog.tableExists(tableId)) {
            if (!catalog.namespaceExists(Namespace.of(glueDbName))) {
                catalog.createNamespace(Namespace.of(glueDbName));
            }
            Map<String, String> tableProps = new HashMap<>();
            tableProps.put("write.format.default", "parquet");
            // Append-only writes never cause data conflicts but can hit catalog commit
            // contention when many partitions commit concurrently — increase retries.
            tableProps.put("commit.retry.num-retries", "10");
            tableProps.put("commit.retry.min-wait-ms", "100");
            tableProps.put("commit.retry.max-wait-ms", "10000");
            // Target ~128 MB Parquet files to avoid small-file explosion from
            // frequent checkpoints.
            tableProps.put("write.target-file-size-bytes", "134217728");
            catalog.createTable(tableId, ICEBERG_SCHEMA, PARTITION_SPEC, tableProps);
        }
        catalog.close();

        // TableLoader is serializable — CatalogLoader.custom instantiates GlueCatalog
        // on each TaskManager using the same catalogProps map.
        TableLoader tableLoader = TableLoader.fromCatalog(
            CatalogLoader.custom("glue_catalog", catalogProps, hadoopConf,
                "org.apache.iceberg.aws.glue.GlueCatalog"),
            tableId
        );

        // ── Kafka source (shared MSK, IAM auth via execution role) ─────────────
        // All participant IoT rules write to the same raw.telemetry topic.
        // deployment_id is stamped by each IoT rule so Flink can partition by it.
        // IAMLoginModule exchanges the task-manager's execution role for a SigV4
        // token — no credentials stored anywhere.
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
            "  ingest_ts         BIGINT," +
            "  deployment_id     STRING," +
            "  `year`  AS DATE_FORMAT(TO_TIMESTAMP_LTZ(message_timestamp, 3), 'yyyy')," +
            "  `month` AS DATE_FORMAT(TO_TIMESTAMP_LTZ(message_timestamp, 3), 'MM')," +
            "  `day`   AS DATE_FORMAT(TO_TIMESTAMP_LTZ(message_timestamp, 3), 'dd')," +
            "  `hour`  AS DATE_FORMAT(TO_TIMESTAMP_LTZ(message_timestamp, 3), 'HH')" +
            ") WITH (" +
            "  'connector'                                      = 'kafka'," +
            "  'topic'                                          = 'raw.telemetry'," +
            "  'properties.bootstrap.servers'                   = '" + bootstrapServers + "'," +
            "  'properties.group.id'                            = 'flink-iceberg-shared'," +
            "  'scan.startup.mode'                              = 'earliest-offset'," +
            "  'format'                                         = 'json'," +
            "  'json.ignore-parse-errors'                       = 'true'," +
            "  'properties.security.protocol'                   = 'SASL_SSL'," +
            "  'properties.sasl.mechanism'                      = 'AWS_MSK_IAM'," +
            "  'properties.sasl.jaas.config'                    = 'software.amazon.msk.auth.iam.IAMLoginModule required;'," +
            "  'properties.sasl.client.callback.handler.class'  = 'software.amazon.msk.auth.iam.IAMClientCallbackHandler'" +
            ")"
        );

        DataStream<Row> rowStream = tEnv.toDataStream(
            tEnv.sqlQuery(
                "SELECT thing_name, message_timestamp, cpu_pct, mem_used_pct, disk_used_pct," +
                "       net_io_bytes_sent, net_io_bytes_recv, mqtt_topic, ingest_ts," +
                "       `year`, `month`, `day`, `hour`, deployment_id " +
                "FROM kafka_telemetry"
            )
        );

        // ── Iceberg FlinkSink (DataStream API, no FlinkCatalogFactory SPI) ───────
        TableSchema tableSchema = FlinkSchemaUtil.toSchema(ICEBERG_SCHEMA);
        FlinkSink.forRow(rowStream, tableSchema)
            .tableLoader(tableLoader)
            .overwrite(false)
            .append();

        env.execute("flink-iceberg-sink");
    }

    private static String requireProp(Properties props, String name) {
        String val = props.getProperty(name);
        if (val == null || val.isBlank()) {
            throw new IllegalStateException("Required application property not set: " + name);
        }
        return val;
    }
}
