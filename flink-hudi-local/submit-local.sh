#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE="docker compose -f $REPO_ROOT/local-kafka-connect/docker-compose.yml"

# 1. Build fat JAR
echo "Building flink-hudi-sink-local-1.0.0.jar ..."
mvn -f "$REPO_ROOT/flink-hudi-local/pom.xml" clean package -q
echo "Build succeeded."

# 2. Ensure workshop-local bucket exists on LocalStack
echo "Ensuring s3://workshop-local exists on LocalStack ..."
$COMPOSE exec localstack awslocal s3 mb s3://workshop-local --region us-east-1 2>/dev/null || true

# 3. Create the raw.telemetry topic if it doesn't exist yet
echo "Ensuring raw.telemetry topic exists on Redpanda ..."
$COMPOSE exec redpanda rpk topic create raw.telemetry --brokers localhost:9092 2>/dev/null || true

# 4. Submit job to the session cluster
echo "Submitting Flink-Hudi job ..."
$COMPOSE exec jobmanager flink run /opt/flink/usrlib/job.jar

echo ""
echo "Job submitted. Monitor at http://localhost:8081"
echo "After ~60 s check Hudi files:"
echo "  $COMPOSE exec localstack awslocal s3 ls s3://workshop-local/hudi-telemetry/ --recursive"
