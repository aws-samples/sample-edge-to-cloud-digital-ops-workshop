#!/usr/bin/env bash
# create-msk-topics.sh — create required MSK Kafka topics for a workshop deployment slot.
#
# MSK has auto.create.topics.enable=false, so topics must exist before Redpanda Connect
# or RisingWave attempt to produce/consume.
#
# Topics created for each deployment slot:
#   sensors.raw.sim               — edge Redpanda → MSK relay (simulator data)
#   sensors.raw.<slot>-edge-0..2  — per-edge-node relay topics
#   raw.telemetry                 — IoT Rule → MSK (system metrics)
#
# Prerequisites:
#   - kafka-topics.sh on PATH  (brew install kafka  OR  apt-get install kafka  OR
#     use --kafka-home to point to an existing Kafka install)
#   - AWS credentials for the workshop account (MSK Secrets Manager + kafka API access)
#   - If kafka-topics.sh isn't found, falls back to Python + kafka-python (pip installed
#     on demand) — no Java/Kafka distribution required for this path.
#
# Usage:
#   scripts/create-msk-topics.sh --deployment-id ws-slot00
#   scripts/create-msk-topics.sh --deployment-id ws-slot00 --kafka-home /opt/kafka
#   scripts/create-msk-topics.sh --deployment-id ws-slot00 --num-edges 3 --partitions 6
#
# Options:
#   --deployment-id  <id>    Deployment slot, e.g. ws-slot00  (required)
#   --num-edges      <n>     Number of edge nodes (default: 3)
#   --partitions     <n>     Partition count per topic (default: 3)
#   --replication    <n>     Replication factor (default: 2)
#   --kafka-home     <path>  Directory containing bin/kafka-topics.sh (default: auto-detect)
#   --region         <r>     AWS region (default: us-east-1)
#   --dry-run                Print commands without running them

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
DEPLOYMENT_ID=""
NUM_EDGES=3
PARTITIONS=3
REPLICATION=2
KAFKA_HOME=""
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
DRY_RUN=false

# ── Arg parsing ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --deployment-id) DEPLOYMENT_ID="$2";  shift 2 ;;
    --num-edges)     NUM_EDGES="$2";      shift 2 ;;
    --partitions)    PARTITIONS="$2";     shift 2 ;;
    --replication)   REPLICATION="$2";    shift 2 ;;
    --kafka-home)    KAFKA_HOME="$2";     shift 2 ;;
    --region)        REGION="$2";         shift 2 ;;
    --dry-run)       DRY_RUN=true;        shift   ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$DEPLOYMENT_ID" ]]; then
  echo "Usage: $0 --deployment-id <ws-slotNN> [options]" >&2
  exit 1
fi

# ── Locate kafka-topics.sh ────────────────────────────────────────────────────
find_kafka_topics() {
  # Explicit override wins
  if [[ -n "$KAFKA_HOME" ]]; then
    echo "${KAFKA_HOME}/bin/kafka-topics.sh"
    return
  fi
  # Common install paths
  for candidate in \
      "$(command -v kafka-topics.sh 2>/dev/null || true)" \
      "$(command -v kafka-topics    2>/dev/null || true)" \
      /opt/kafka/bin/kafka-topics.sh \
      /usr/local/bin/kafka-topics.sh \
      /usr/bin/kafka-topics.sh; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return
    fi
  done
  echo ""
}

KAFKA_TOPICS_BIN=$(find_kafka_topics)
USE_PYTHON_FALLBACK=false
if [[ -z "$KAFKA_TOPICS_BIN" ]]; then
  echo "kafka-topics.sh not found on PATH — falling back to Python (kafka-python)." >&2
  USE_PYTHON_FALLBACK=true
fi

# ── Fetch MSK credentials and broker endpoint ─────────────────────────────────
echo "▶ Fetching MSK credentials from Secrets Manager …"
SECRET_JSON=$(aws secretsmanager get-secret-value \
  --region "$REGION" \
  --secret-id "AmazonMSK_workshop-${DEPLOYMENT_ID}" \
  --query SecretString --output text)

MSK_USER=$(echo "$SECRET_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['username'])")
MSK_PASS=$(echo "$SECRET_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['password'])")

echo "▶ Fetching MSK bootstrap brokers …"
MSK_CLUSTER_ARN=$(aws kafka list-clusters-v2 \
  --region "$REGION" \
  --filter-by-name "workshop-${DEPLOYMENT_ID}-msk" \
  --query "ClusterInfoList[0].ClusterArn" --output text)

if [[ -z "$MSK_CLUSTER_ARN" || "$MSK_CLUSTER_ARN" == "None" ]]; then
  # Fall back to shared CloudFormation export if the per-slot cluster name differs
  MSK_CLUSTER_ARN=$(aws cloudformation list-exports \
    --region "$REGION" \
    --query "Exports[?Name=='workshop-platform-msk-arn'].Value" \
    --output text 2>/dev/null || true)
fi

if [[ -z "$MSK_CLUSTER_ARN" || "$MSK_CLUSTER_ARN" == "None" ]]; then
  echo "ERROR: Could not locate MSK cluster ARN for ${DEPLOYMENT_ID}." >&2
  exit 1
fi

MSK_BOOTSTRAP=$(aws kafka get-bootstrap-brokers \
  --region "$REGION" \
  --cluster-arn "$MSK_CLUSTER_ARN" \
  --query BootstrapBrokerStringSaslScram --output text)

echo "  Bootstrap: $MSK_BOOTSTRAP"

# ── Write a temporary JAAS / client.properties file ──────────────────────────
PROPS_FILE=$(mktemp /tmp/msk-client-XXXXXX.properties)
trap "rm -f $PROPS_FILE" EXIT

cat > "$PROPS_FILE" <<PROPS
security.protocol=SASL_SSL
sasl.mechanism=SCRAM-SHA-512
sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required \
  username="${MSK_USER}" \
  password="${MSK_PASS}";
PROPS

# ── Build topic list ──────────────────────────────────────────────────────────
TOPICS=(
  "sensors.raw.sim"
  "raw.telemetry"
)
for (( i=0; i<NUM_EDGES; i++ )); do
  TOPICS+=("sensors.raw.${DEPLOYMENT_ID}-edge-${i}")
done

# ── Create topics ─────────────────────────────────────────────────────────────
echo ""
echo "▶ Creating ${#TOPICS[@]} topics (partitions=${PARTITIONS}, replication=${REPLICATION}) …"
echo ""

if $DRY_RUN; then
  for TOPIC in "${TOPICS[@]}"; do
    if $USE_PYTHON_FALLBACK; then
      echo "  DRY-RUN: python3 (kafka-python) create_topics ${TOPIC} partitions=${PARTITIONS} replication=${REPLICATION}"
    else
      echo "  DRY-RUN: ${KAFKA_TOPICS_BIN} --bootstrap-server ${MSK_BOOTSTRAP} --command-config ${PROPS_FILE} --create --topic ${TOPIC} --partitions ${PARTITIONS} --replication-factor ${REPLICATION} --if-not-exists"
    fi
  done
  exit 0
fi

if $USE_PYTHON_FALLBACK; then
  python3 -m pip install --quiet --user kafka-python
  TOPICS_JSON=$(printf '%s\n' "${TOPICS[@]}" | python3 -c "import sys,json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))")
  python3 - "$MSK_BOOTSTRAP" "$MSK_USER" "$MSK_PASS" "$PARTITIONS" "$REPLICATION" "$TOPICS_JSON" <<'PYEOF'
import sys, json
from kafka.admin import KafkaAdminClient, NewTopic
from kafka.errors import TopicAlreadyExistsError

bootstrap, user, password, partitions, replication, topics_json = sys.argv[1:7]
topics = json.loads(topics_json)

admin = KafkaAdminClient(
    bootstrap_servers=bootstrap.split(","),
    security_protocol="SASL_SSL",
    sasl_mechanism="SCRAM-SHA-512",
    sasl_plain_username=user,
    sasl_plain_password=password,
)

created, already, failed = 0, 0, 0
for topic in topics:
    new_topic = NewTopic(name=topic, num_partitions=int(partitions), replication_factor=int(replication))
    try:
        admin.create_topics([new_topic])
        print(f"  ✓ (created) {topic}")
        created += 1
    except TopicAlreadyExistsError:
        print(f"  ✓ (exists) {topic}")
        already += 1
    except Exception as e:
        print(f"  ✗ FAILED  {topic} — {e}", file=sys.stderr)
        failed += 1

admin.close()
print()
print(f"Done — created: {created}, already existed: {already}, failed: {failed}")
sys.exit(1 if failed else 0)
PYEOF
  exit $?
fi

CREATED=0
ALREADY=0
FAILED=0

for TOPIC in "${TOPICS[@]}"; do
  CMD=(
    "$KAFKA_TOPICS_BIN"
    --bootstrap-server "$MSK_BOOTSTRAP"
    --command-config "$PROPS_FILE"
    --create
    --topic "$TOPIC"
    --partitions "$PARTITIONS"
    --replication-factor "$REPLICATION"
    --if-not-exists
  )

  OUTPUT=$("${CMD[@]}" 2>&1) && EXIT_CODE=0 || EXIT_CODE=$?

  if [[ $EXIT_CODE -eq 0 ]]; then
    if echo "$OUTPUT" | grep -qi "already exists"; then
      echo "  ✓ (exists) $TOPIC"
      ALREADY=$((ALREADY + 1))
    else
      echo "  ✓ (created) $TOPIC"
      CREATED=$((CREATED + 1))
    fi
  else
    echo "  ✗ FAILED  $TOPIC — $OUTPUT" >&2
    FAILED=$((FAILED + 1))
  fi
done

echo ""
echo "Done — created: ${CREATED}, already existed: ${ALREADY}, failed: ${FAILED}"
[[ $FAILED -gt 0 ]] && exit 1 || exit 0
