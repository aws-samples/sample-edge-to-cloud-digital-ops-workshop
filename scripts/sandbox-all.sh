#!/usr/bin/env bash
# Usage: ./scripts/sandbox-all.sh ws-a1b2c3 ws-b4c5d6 [...]
#   Deploys the shared platform stack (always — cdk deploy is idempotent),
#   then deploys an Amplify sandbox for each deployment ID sequentially.

set -euo pipefail

DEPLOYMENT_IDS=()
for arg in "$@"; do
  DEPLOYMENT_IDS+=("$arg")
done

if [[ ${#DEPLOYMENT_IDS[@]} -eq 0 ]]; then
  echo "Usage: $0 <deployment-id> [deployment-id ...]" >&2
  exit 1
fi

PLATFORM_APP="npx tsx amplify/custom/platform-app.ts"
PLATFORM_STACK_NAME="WorkshopPlatformStack"
FLINK_JAR_KEY="flink-apps/flink-iceberg-sink-1.0.0.jar"

# ── Deploy platform stack (always) ───────────────────────────────────────────
# cdk deploy is idempotent: if nothing changed it finishes in seconds.
#
# The Managed Flink app reads its code JAR from the shared bucket this same
# stack creates. On a fresh account neither the bucket nor the JAR exist yet,
# so a normal deploy fails on the Flink resource and CloudFormation rolls
# back everything else that was just created (VPCs/EKS/MSK included). Detect
# that case up front and deploy without the Flink app first; it gets added
# back in a second deploy below once the JAR has been uploaded.
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
PLATFORM_BUCKET="workshop-platform-${ACCOUNT_ID}"
NEEDS_FLINK_REDEPLOY=0
DEPLOY_CONTEXT_ARGS=()
if ! aws s3api head-object --bucket "$PLATFORM_BUCKET" --key "$FLINK_JAR_KEY" >/dev/null 2>&1; then
  echo ">>> Flink JAR not found at s3://${PLATFORM_BUCKET}/${FLINK_JAR_KEY} — deploying platform stack without the Flink app first."
  DEPLOY_CONTEXT_ARGS=(--context deployFlinkApp=false)
  NEEDS_FLINK_REDEPLOY=1
fi

echo ">>> Deploying $PLATFORM_STACK_NAME..."
npx cdk deploy \
  --app "$PLATFORM_APP" \
  --require-approval never \
  "${DEPLOY_CONTEXT_ARGS[@]}" \
  "$PLATFORM_STACK_NAME"
echo ">>> Platform stack deployed."

# ── Start Flink application if not already running ───────────────────────────
FLINK_APP_NAME=$(aws cloudformation list-exports \
  --query "Exports[?Name=='workshop-platform-flink-app-name'].Value" \
  --output text 2>/dev/null || echo "")
if [[ -n "$FLINK_APP_NAME" ]]; then
  FLINK_STATUS=$(aws kinesisanalyticsv2 describe-application \
    --application-name "$FLINK_APP_NAME" \
    --query "ApplicationDetail.ApplicationStatus" \
    --output text 2>/dev/null || echo "NOT_FOUND")
  if [[ "$FLINK_STATUS" == "READY" ]]; then
    echo ">>> Starting Flink application $FLINK_APP_NAME..."
    aws kinesisanalyticsv2 start-application \
      --application-name "$FLINK_APP_NAME" \
      --run-configuration '{"ApplicationRestoreConfiguration":{"ApplicationRestoreType":"SKIP_RESTORE_FROM_SNAPSHOT"}}' \
      && echo ">>> Flink application start initiated (status transitions to STARTING then RUNNING)." \
      || echo ">>> WARNING: kinesisanalyticsv2:StartApplication failed (e.g. missing IAM permission) — continuing without starting Flink."
  elif [[ "$FLINK_STATUS" == "RUNNING" || "$FLINK_STATUS" == "STARTING" ]]; then
    echo ">>> Flink application $FLINK_APP_NAME already $FLINK_STATUS — skipping start."
  else
    echo ">>> WARNING: Flink application $FLINK_APP_NAME is in status $FLINK_STATUS — skipping start."
  fi
else
  echo ">>> WARNING: Could not resolve Flink app name from CloudFormation exports — skipping start."
fi

# ── Patch Glue Iceberg table for Lake Formation compatibility ─────────────────
# GlueCatalog creates the Iceberg table with null InputFormat/SerdeInfo.
# On accounts with Lake Formation fine-grained access control this causes Athena
# to return "Relation contains no accessible columns". Fix by adding Iceberg
# SerDe + explicit columns so LF can evaluate column-level grants.
# Idempotent: skipped if InputFormat is already set, or if table doesn't exist yet.
_patch_glue_iceberg_table() {
  local glue_db="workshop_telemetry"
  local glue_table="telemetry"
  local meta_loc input_fmt s3_bucket_resolved

  meta_loc=$(aws glue get-table \
    --database-name "$glue_db" --name "$glue_table" \
    --query "Table.Parameters.metadata_location" --output text 2>/dev/null) || true
  input_fmt=$(aws glue get-table \
    --database-name "$glue_db" --name "$glue_table" \
    --query "Table.StorageDescriptor.InputFormat" --output text 2>/dev/null) || true

  if [[ -z "$meta_loc" || "$meta_loc" == "None" ]]; then
    echo ">>> Glue table not yet created (Flink creates it on first record) — skipping SerDe patch."
    return 0
  fi
  if [[ -n "$input_fmt" && "$input_fmt" != "None" ]]; then
    echo ">>> Glue table SerDe already set — skipping patch."
    return 0
  fi

  echo ">>> Patching Glue Iceberg table SerDe for Lake Formation compatibility..."
  s3_bucket_resolved=$(aws cloudformation list-exports \
    --query "Exports[?Name=='workshop-platform-bucket-name'].Value" \
    --output text 2>/dev/null)
  aws glue update-table \
    --database-name "$glue_db" \
    --table-input "{
      \"Name\": \"${glue_table}\",
      \"TableType\": \"EXTERNAL_TABLE\",
      \"Parameters\": {\"table_type\": \"ICEBERG\", \"metadata_location\": \"${meta_loc}\"},
      \"StorageDescriptor\": {
        \"Location\": \"s3://${s3_bucket_resolved}/telemetry/workshop_telemetry.db/telemetry\",
        \"Columns\": [
          {\"Name\":\"thing_name\",\"Type\":\"string\"},
          {\"Name\":\"message_timestamp\",\"Type\":\"bigint\"},
          {\"Name\":\"cpu_pct\",\"Type\":\"int\"},
          {\"Name\":\"mem_used_pct\",\"Type\":\"int\"},
          {\"Name\":\"disk_used_pct\",\"Type\":\"int\"},
          {\"Name\":\"net_io_bytes_sent\",\"Type\":\"bigint\"},
          {\"Name\":\"net_io_bytes_recv\",\"Type\":\"bigint\"},
          {\"Name\":\"mqtt_topic\",\"Type\":\"string\"},
          {\"Name\":\"ingest_ts\",\"Type\":\"bigint\"},
          {\"Name\":\"year\",\"Type\":\"string\"},
          {\"Name\":\"month\",\"Type\":\"string\"},
          {\"Name\":\"day\",\"Type\":\"string\"},
          {\"Name\":\"hour\",\"Type\":\"string\"},
          {\"Name\":\"deployment_id\",\"Type\":\"string\"}
        ],
        \"InputFormat\": \"org.apache.iceberg.mr.mapred.MapredIcebergInputFormat\",
        \"OutputFormat\": \"org.apache.iceberg.mr.hive.HiveIcebergOutputFormat\",
        \"SerdeInfo\": {\"SerializationLibrary\": \"org.apache.iceberg.mr.hive.HiveIcebergSerDe\"}
      }
    }" 2>&1 \
    && echo ">>> Glue table SerDe patched." \
    || echo ">>> WARNING: Glue table patch failed — may need ALTER permission via Lake Formation."
}
_patch_glue_iceberg_table

# ── Ensure raw.telemetry Kafka topic exists ───────────────────────────────────
# IoT Kafka action can't auto-create topics. We create it idempotently via a
# short-lived pod in the EKS cluster (which is in the cloud VPC with MSK access).
MSK_SCRAM_BROKERS=$(aws cloudformation list-exports \
  --query "Exports[?Name=='workshop-platform-msk-bootstrap-scram'].Value" \
  --output text 2>/dev/null || echo "")
EKS_CLUSTER_NAME=$(aws cloudformation list-exports \
  --query "Exports[?Name=='workshop-eks-cluster-name'].Value" \
  --output text 2>/dev/null || echo "workshop-eks")
ADMIN_SECRET_NAME=$(aws secretsmanager list-secrets \
  --filter Key=name,Values=AmazonMSK_workshop- \
  --query "SecretList[0].Name" --output text 2>/dev/null || echo "")

if [[ -n "$MSK_SCRAM_BROKERS" && -n "$ADMIN_SECRET_NAME" ]]; then
  ADMIN_SECRET=$(aws secretsmanager get-secret-value \
    --secret-id "$ADMIN_SECRET_NAME" --query "SecretString" --output text 2>/dev/null || echo "")
  ADMIN_USER=$(echo "$ADMIN_SECRET" | python3 -c "import json,sys; print(json.load(sys.stdin)['username'])" 2>/dev/null || echo "")
  ADMIN_PASS=$(echo "$ADMIN_SECRET" | python3 -c "import json,sys; print(json.load(sys.stdin)['password'])" 2>/dev/null || echo "")

  aws eks update-kubeconfig --name "$EKS_CLUSTER_NAME" --region "${AWS_DEFAULT_REGION:-us-east-1}" 2>/dev/null || true

  # Write manifest to a temp file using python to safely embed shell command with special chars
  TOPIC_POD_MANIFEST_FILE=$(mktemp /tmp/kafka-topic-init.XXXXXX)
  python3 - "$ADMIN_USER" "$ADMIN_PASS" "$MSK_SCRAM_BROKERS" "$TOPIC_POD_MANIFEST_FILE" << 'PYEOF'
import sys, json

admin_user, admin_pass, brokers, outfile = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
props = (
    "security.protocol=SASL_SSL\\n"
    "sasl.mechanism=SCRAM-SHA-512\\n"
    f"sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required "
    f'username=\\"{admin_user}\\" password=\\"{admin_pass}\\";\\n'
)
cmd = (
    f"printf '{props}' > /tmp/client.properties && "
    f"kafka-topics --bootstrap-server {brokers} "
    "--command-config /tmp/client.properties "
    "--create --if-not-exists --topic raw.telemetry "
    "--partitions 2 --replication-factor 2 "
    "&& echo TOPIC_OK || echo TOPIC_FAILED"
)
manifest = {
    "apiVersion": "v1",
    "kind": "Pod",
    "metadata": {"name": "kafka-topic-init", "namespace": "default"},
    "spec": {
        "restartPolicy": "Never",
        "containers": [{
            "name": "kafka",
            "image": "confluentinc/cp-kafka:7.5.0",
            "imagePullPolicy": "IfNotPresent",
            "command": ["/bin/bash", "-c"],
            "args": [cmd]
        }]
    }
}
import yaml
with open(outfile, "w") as f:
    yaml.dump(manifest, f, default_flow_style=False)
PYEOF

  kubectl delete pod kafka-topic-init --ignore-not-found 2>/dev/null || true
  kubectl apply -f "$TOPIC_POD_MANIFEST_FILE" 2>/dev/null || true
  rm -f "$TOPIC_POD_MANIFEST_FILE"
  echo ">>> Waiting for raw.telemetry topic creation..."
  kubectl wait --for=condition=ready pod/kafka-topic-init --timeout=120s 2>/dev/null || true
  TOPIC_RESULT=$(kubectl logs kafka-topic-init 2>/dev/null | grep -E "TOPIC_OK|TOPIC_FAILED" | tail -1) || true
  kubectl delete pod kafka-topic-init --ignore-not-found 2>/dev/null || true
  echo ">>> Kafka topic init: ${TOPIC_RESULT:-completed}"
else
  echo ">>> WARNING: Could not resolve MSK brokers or admin secret — skipping topic creation."
fi

# ── Publish edge NAT gateway ID to SSM (once) ────────────────────────────────
# //TODO - Move this into the platform stack. This should not be an sdk call.
EDGE_NAT_SSM="/workshop/platform/edge-nat-gateway-id"
EXISTING_NAT_SSM=$(aws ssm get-parameter --name "$EDGE_NAT_SSM" --query "Parameter.Value" --output text 2>/dev/null || echo "None")
if [[ "$EXISTING_NAT_SSM" != "None" && -n "$EXISTING_NAT_SSM" ]]; then
  echo ">>> SSM $EDGE_NAT_SSM already set: $EXISTING_NAT_SSM. Skipping."
else
  EDGE_VPC_ID=$(aws ec2 describe-vpcs \
    --filters "Name=tag:Name,Values=workshop-edge" \
    --query "Vpcs[0].VpcId" --output text)
  EDGE_NAT_ID=$(aws ec2 describe-nat-gateways \
    --filter "Name=vpc-id,Values=${EDGE_VPC_ID}" "Name=state,Values=available" \
    --query "NatGateways[0].NatGatewayId" --output text)
  if [[ -z "$EDGE_NAT_ID" || "$EDGE_NAT_ID" == "None" ]]; then
    echo "ERROR: No NAT gateway found in edge VPC $EDGE_VPC_ID — is the platform stack deployed?" >&2
    exit 1
  fi
  aws ssm put-parameter --name "$EDGE_NAT_SSM" --value "$EDGE_NAT_ID" --type String --overwrite
  echo ">>> SSM $EDGE_NAT_SSM set to $EDGE_NAT_ID."
fi

# ── Create shared IoT VPC destination (once) ────────────────────────────────
# //TODO - This should also be created in the platform stack
echo ">>> Creating/confirming IoT VPC destination..."
bash "$(dirname "$0")/create-iot-vpc-dest.sh"

# ── Resolve S3 bucket from CloudFormation export ─────────────────────────────
S3_BUCKET=$(aws cloudformation list-exports \
  --query "Exports[?Name=='workshop-platform-bucket-name'].Value" \
  --output text)

# ── Upload shared binaries and simulator to S3 ───────────────────────────────
LOCAL_BINARY_CACHE="$HOME/.cache/workshop/aws-iot-device-client"
if [[ -f "$LOCAL_BINARY_CACHE" ]]; then
  echo ">>> Uploading IoT Device Client binary to s3://${S3_BUCKET}/bin/aws-iot-device-client..."
  aws s3 cp "$LOCAL_BINARY_CACHE" "s3://${S3_BUCKET}/bin/aws-iot-device-client"
else
  echo ">>> WARNING: IoT Device Client binary not found at $LOCAL_BINARY_CACHE — run scripts/sandbox.sh once to build it"
fi

echo ">>> Uploading sensor simulator to s3://${S3_BUCKET}/simulator/sensor-sim.py..."
aws s3 cp simulator/sensor-sim.py "s3://${S3_BUCKET}/simulator/sensor-sim.py"
echo ">>> Shared uploads complete."

# ── Build and upload Flink JAR to S3 ─────────────────────────────────────────
# Managed Flink reads the JAR from S3 at app start. Build if the key doesn't
# exist yet — rebuild is skipped on subsequent runs to avoid the 5-min Maven build.
FLINK_JAR_EXISTS=$(aws s3 ls "s3://${S3_BUCKET}/${FLINK_JAR_KEY}" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$FLINK_JAR_EXISTS" -eq 0 ]]; then
  echo ">>> Building Flink JAR..."
  (cd "$(dirname "$0")/../flink-hudi-sink" && mvn clean package -q -DskipTests)
  aws s3 cp "$(dirname "$0")/../flink-hudi-sink/target/flink-iceberg-sink-1.0.0.jar" \
    "s3://${S3_BUCKET}/${FLINK_JAR_KEY}"
  echo ">>> Flink JAR uploaded to s3://${S3_BUCKET}/${FLINK_JAR_KEY}"
else
  echo ">>> Flink JAR already in s3://${S3_BUCKET}/${FLINK_JAR_KEY} — skipping build."
fi

# ── Redeploy platform stack with the Flink app now that the JAR exists ──────
if [[ "$NEEDS_FLINK_REDEPLOY" -eq 1 ]]; then
  echo ">>> Redeploying $PLATFORM_STACK_NAME with the Flink app enabled..."
  npx cdk deploy \
    --app "$PLATFORM_APP" \
    --require-approval never \
    "$PLATFORM_STACK_NAME"
  echo ">>> Platform stack redeployed with Flink app."
fi

# ── Deploy one Amplify sandbox per participant (sequential) ──────────────────
# ampx sandbox locks .amplify/artifacts/cdk.out per project, so parallel synths
# all race for the lock and fail. Run sequentially to avoid the contention.
echo ">>> Deploying ${#DEPLOYMENT_IDS[@]} sandboxes sequentially..."

FAILED=0
for ID in "${DEPLOYMENT_IDS[@]}"; do
  echo ">>> [$ID] Starting sandbox..."
  if ! bash -c '
    . "$HOME/.nvm/nvm.sh"
    nvm use 22 --silent
    WORKSHOP_DEPLOYMENT_ID="'"$ID"'" npx ampx sandbox --identifier "'"$ID"'" --once
  '; then
    echo "ERROR: sandbox for $ID failed" >&2
    FAILED=1
  else
    echo ">>> [$ID] Sandbox complete."
  fi
done

if [[ $FAILED -eq 0 ]]; then
  echo ">>> All sandboxes deployed. Generating deployment summary..."
  bash "$(dirname "$0")/deployment-summary.sh" "${DEPLOYMENT_IDS[@]}"
fi

exit $FAILED
