#!/usr/bin/env bash
# End-to-end local test:
#   1. Create the S3 bucket in LocalStack
#   2. Create the raw.telemetry topic
#   3. Register the Hudi sink connector
#   4. Produce 5 test records
#   5. Wait for a commit, then verify Hudi files appear in S3
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONNECT_URL="http://localhost:8083"
LOCALSTACK_URL="http://localhost:4566"

echo ">>> Creating S3 bucket in LocalStack..."
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
  aws --endpoint-url "$LOCALSTACK_URL" --region us-east-1 \
  s3 mb s3://workshop-local 2>/dev/null || echo "    (bucket already exists)"

echo ">>> Creating raw.telemetry topic..."
docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec redpanda \
  rpk topic create raw.telemetry --partitions 1 --replicas 1 2>/dev/null || echo "    (topic already exists)"

echo ">>> Registering connector..."
curl -sf -X DELETE "$CONNECT_URL/connectors/hudi-sink-local" 2>/dev/null || true
curl -sf -X POST "$CONNECT_URL/connectors" \
  -H "Content-Type: application/json" \
  -d @"$SCRIPT_DIR/connector-config.json"
echo ""

echo ">>> Waiting for connector to reach RUNNING state..."
for i in $(seq 1 30); do
  STATE=$(curl -sf "$CONNECT_URL/connectors/hudi-sink-local/status" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['connector']['state'])" 2>/dev/null || echo "PENDING")
  echo "    [$i] $STATE"
  [[ "$STATE" == "RUNNING" ]] && break
  [[ "$STATE" == "FAILED" ]] && {
    echo "FAILED — connector error:"
    curl -sf "$CONNECT_URL/connectors/hudi-sink-local/status" | python3 -m json.tool
    exit 1
  }
  sleep 2
done

echo ">>> Producing 5 test records to raw.telemetry..."
TS=$(python3 -c "import time; print(int(time.time() * 1000))")
for i in 1 2 3 4 5; do
  MSG="{\"thing_name\":\"edge-device-0${i}\",\"message_timestamp\":$((TS + i * 1000)),\"cpu_pct\":$((RANDOM % 100)),\"mem_used_pct\":$((RANDOM % 100)),\"disk_used_pct\":$((RANDOM % 100)),\"net_io_bytes_sent\":$((RANDOM * 100)),\"net_io_bytes_recv\":$((RANDOM * 100)),\"mqtt_topic\":\"edge/ws-slot00/device-0${i}/telemetry\",\"ingest_ts\":$((TS + i * 1000))}"
  echo "$MSG" | docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T redpanda \
    rpk topic produce raw.telemetry --brokers localhost:9092
done
echo ">>> 5 records produced."

echo ">>> Waiting up to 30s for Hudi commit (hoodie.kafka.commit.interval.secs=10)..."
for i in $(seq 1 15); do
  FILES=$(AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
    aws --endpoint-url "$LOCALSTACK_URL" --region us-east-1 \
    s3 ls s3://workshop-local/telemetry/ --recursive 2>/dev/null | grep -c "\.parquet\|hoodie" || true)
  echo "    [$i] Hudi files found: $FILES"
  [[ "$FILES" -gt 0 ]] && break
  sleep 2
done

echo ""
echo ">>> S3 contents under s3://workshop-local/telemetry/:"
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
  aws --endpoint-url "$LOCALSTACK_URL" --region us-east-1 \
  s3 ls s3://workshop-local/telemetry/ --recursive

echo ""
echo ">>> Connector status:"
curl -sf "$CONNECT_URL/connectors/hudi-sink-local/status" | python3 -m json.tool
