#!/usr/bin/env bash
# Build the Flink Iceberg sink uber-JAR and upload it to the workshop S3 bucket.
#
# Usage: ./build-and-upload.sh <bucket-name>
# Example: ./build-and-upload.sh workshop-ws-slot00-123456789012
set -euo pipefail

BUCKET="${1:?Usage: $0 <bucket-name>}"
S3_KEY="flink-apps/flink-hudi-sink-1.0.0.jar"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Building uber-JAR..."
mvn clean package -q -DskipTests

JAR="target/flink-iceberg-sink-1.0.0.jar"

echo "==> Uploading s3://${BUCKET}/${S3_KEY}..."
aws s3 cp "$JAR" "s3://${BUCKET}/${S3_KEY}"

echo "==> Done. JAR is at s3://${BUCKET}/${S3_KEY}"
