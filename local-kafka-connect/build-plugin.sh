#!/usr/bin/env bash
# Downloads the Hudi Kafka Connect JAR and required Hadoop JARs into the plugin directory.
# Mirrors what the CDK Lambda does but runs locally for fast iteration.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$SCRIPT_DIR/plugins/kafka-connect-hudi"
CACHE_DIR="$SCRIPT_DIR/.jar-cache"
MAVEN="https://repo1.maven.org/maven2"
SINK_CLASS="org.apache.hudi.connect.HoodieSinkConnector"

HUDI_VERSION="0.14.1"
HADOOP_VERSION="3.3.4"
AWS_SDK_VERSION="1.12.648"
COMMONS_CONFIG2_VERSION="2.1.1"
COMMONS_LANG3_VERSION="3.12.0"
COMMONS_BEANUTILS_VERSION="1.9.4"
COMMONS_LOGGING_VERSION="1.1.3"
WOODSTOX_VERSION="5.4.0"
STAX2_VERSION="4.2.1"

JARS=(
  "org/apache/hudi/hudi-kafka-connect-bundle/${HUDI_VERSION}/hudi-kafka-connect-bundle-${HUDI_VERSION}.jar"
  # hadoop-common provides the public API (FSDataInputStream, Configuration, etc.)
  "org/apache/hadoop/hadoop-common/${HADOOP_VERSION}/hadoop-common-${HADOOP_VERSION}.jar"
  # hadoop-client-runtime provides shaded guava (org.apache.hadoop.thirdparty.*) required by hadoop-common 3.3+
  "org/apache/hadoop/hadoop-client-runtime/${HADOOP_VERSION}/hadoop-client-runtime-${HADOOP_VERSION}.jar"
  "org/apache/hadoop/hadoop-aws/${HADOOP_VERSION}/hadoop-aws-${HADOOP_VERSION}.jar"
  "com/amazonaws/aws-java-sdk-bundle/${AWS_SDK_VERSION}/aws-java-sdk-bundle-${AWS_SDK_VERSION}.jar"
  # hadoop-common transitive deps (not shaded inside hadoop-client-runtime)
  "org/apache/commons/commons-configuration2/${COMMONS_CONFIG2_VERSION}/commons-configuration2-${COMMONS_CONFIG2_VERSION}.jar"
  "org/apache/commons/commons-lang3/${COMMONS_LANG3_VERSION}/commons-lang3-${COMMONS_LANG3_VERSION}.jar"
  "commons-beanutils/commons-beanutils/${COMMONS_BEANUTILS_VERSION}/commons-beanutils-${COMMONS_BEANUTILS_VERSION}.jar"
  "commons-logging/commons-logging/${COMMONS_LOGGING_VERSION}/commons-logging-${COMMONS_LOGGING_VERSION}.jar"
  "com/fasterxml/woodstox/woodstox-core/${WOODSTOX_VERSION}/woodstox-core-${WOODSTOX_VERSION}.jar"
  "org/codehaus/woodstox/stax2-api/${STAX2_VERSION}/stax2-api-${STAX2_VERSION}.jar"
)

mkdir -p "$PLUGIN_DIR/META-INF/services" "$CACHE_DIR"

for JAR_PATH in "${JARS[@]}"; do
  FILENAME="${JAR_PATH##*/}"
  CACHE_FILE="$CACHE_DIR/$FILENAME"
  if [[ ! -f "$CACHE_FILE" ]]; then
    echo ">>> Downloading $FILENAME ..."
    curl -L --progress-bar "$MAVEN/$JAR_PATH" -o "$CACHE_FILE"
  else
    echo ">>> Using cached $FILENAME"
  fi
  cp "$CACHE_FILE" "$PLUGIN_DIR/$FILENAME"
done

# Inject the Kafka Connect service descriptor so the Connect runtime discovers the class.
echo "$SINK_CLASS" > "$PLUGIN_DIR/META-INF/services/org.apache.kafka.connect.sink.SinkConnector"

echo ">>> Plugin staged at $PLUGIN_DIR"
echo ">>> Contents:"
ls -lh "$PLUGIN_DIR"
