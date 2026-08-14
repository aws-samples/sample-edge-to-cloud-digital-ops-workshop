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

# Validate every requested slot name BEFORE any CDK/AWS call. slot-list.sh's
# normaliser (_slots_normalise) silently drops anything that doesn't match
# this same pattern when merging into WORKSHOP_SLOTS — without this check a
# typo'd slot would vanish from the deploy set while the post-deploy tail
# below still ran for it against a stack that was never created.
SLOT_NAME_RE='^ws-slot[0-9]{2}$'
for id in "${DEPLOYMENT_IDS[@]}"; do
  if [[ ! "$id" =~ $SLOT_NAME_RE ]]; then
    echo "ERROR: invalid slot name '$id' — slot names must match ${SLOT_NAME_RE} (e.g. ws-slot00)." >&2
    exit 1
  fi
done

PLATFORM_APP="npx tsx amplify/custom/platform-app.ts"
PLATFORM_STACK_NAME="WorkshopPlatformStack"

# The platform stack now manages /workshop/platform/edge-nat-gateway-id as a CFN
# resource. On accounts first provisioned by an older platform stack the value
# exists as an out-of-band orphan (written by a previous version of this script);
# CFN can't *create* a managed parameter on top of an existing unmanaged one.
# Before (re)deploying the platform stack, delete the orphan — but never a value
# that is already a resource of the stack (that one belongs to CFN).
ensure_no_orphan_nat_ssm() {
  local stack_name="$1"
  local param="/workshop/platform/edge-nat-gateway-id"
  aws ssm get-parameter --name "$param" >/dev/null 2>&1 || return 0  # nothing there
  if aws cloudformation describe-stack-resources --stack-name "$stack_name" \
      --query "StackResources[?ResourceType=='AWS::SSM::Parameter'].PhysicalResourceId" \
      --output text 2>/dev/null | grep -qx "$param"; then
    return 0  # already stack-managed — leave it for the update to reconcile
  fi
  echo ">>> Deleting orphaned SSM $param (not stack-managed) before platform deploy."
  aws ssm delete-parameter --name "$param" >/dev/null 2>&1 || true
}

# The platform stack now manages the workshop_telemetry Glue database/table as
# CFN resources (Firehose → Iceberg sink). On accounts that previously ran the
# old Flink pipeline, these exist as out-of-band orphans (created at runtime by
# the Flink app, never by CFN); CFN can't *create* a managed database on top of
# an existing unmanaged one. Before (re)deploying the platform stack, delete the
# orphan — but never one that is already a resource of the stack (that one
# belongs to CFN).
ensure_no_orphan_glue_telemetry_table() {
  local stack_name="$1"
  local db="workshop_telemetry"
  local table="telemetry"
  aws glue get-database --name "$db" >/dev/null 2>&1 || return 0  # nothing there
  if aws cloudformation describe-stack-resources --stack-name "$stack_name" \
      --query "StackResources[?ResourceType=='AWS::Glue::Database'].PhysicalResourceId" \
      --output text 2>/dev/null | grep -qx "$db"; then
    return 0  # already stack-managed — leave it for the update to reconcile
  fi
  echo ">>> Deleting orphaned Glue table/database $db.$table (not stack-managed) before platform deploy."
  aws glue delete-table --database-name "$db" --name "$table" >/dev/null 2>&1 || true
  aws glue delete-database --name "$db" >/dev/null 2>&1 || true
}

# ── Deploy platform stack (always) ───────────────────────────────────────────
# cdk deploy is idempotent: if nothing changed it finishes in seconds.
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# To grant cluster-scoped EKS access (cert-manager/risingwave-operator/cnpg
# installs in block-1-deploy.md) to CI or a second facilitator role that isn't
# the one that ran the very first deploy, export
# WORKSHOP_EKS_ADMIN_PRINCIPAL_ARNS (comma-separated) before running this
# script — platform-app.ts reads it directly. See platform-stack.ts.

ensure_no_orphan_nat_ssm "$PLATFORM_STACK_NAME"
ensure_no_orphan_glue_telemetry_table "$PLATFORM_STACK_NAME"

# ── Merge the requested slots into the persisted active-slot set (#181/#184) ──
# The platform stack is now ONE stack whose per-slot nested stacks are driven by
# WORKSHOP_SLOTS; the list is authoritative, so a deploy that omitted a slot
# would tear it down. Union the requested slots with the already-active set so
# adding slots never drops existing ones. See scripts/slot-list.sh.
# shellcheck source=scripts/slot-list.sh
source "$(dirname "$0")/slot-list.sh"
ALL_SLOTS=$(slots_add "${DEPLOYMENT_IDS[@]}")
echo ">>> Active slot set is now: ${ALL_SLOTS}"

: "${CDK_DEFAULT_ACCOUNT:=$ACCOUNT_ID}"
CDK_DEFAULT_REGION="${CDK_DEFAULT_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region || echo us-east-1)}}"
export CDK_DEFAULT_ACCOUNT CDK_DEFAULT_REGION

echo ">>> Deploying $PLATFORM_STACK_NAME (platform + all ${ALL_SLOTS} slots as nested stacks)..."
WORKSHOP_SLOTS="$ALL_SLOTS" npx cdk deploy \
  --app "$PLATFORM_APP" \
  --require-approval never \
  "$PLATFORM_STACK_NAME"
echo ">>> Platform stack + all slots deployed."

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

# ── Verify edge NAT gateway ID in SSM ────────────────────────────────────────
# The platform stack publishes /workshop/platform/edge-nat-gateway-id (tied to
# the NAT gateway's lifecycle, so it's always fresh). ParticipantStack reads it.
# This is a read-only sanity check — the script no longer writes the value.
EDGE_NAT_SSM="/workshop/platform/edge-nat-gateway-id"
EXISTING_NAT_SSM=$(aws ssm get-parameter --name "$EDGE_NAT_SSM" --query "Parameter.Value" --output text 2>/dev/null || echo "None")
if [[ "$EXISTING_NAT_SSM" == "None" || -z "$EXISTING_NAT_SSM" ]]; then
  echo "ERROR: SSM $EDGE_NAT_SSM is not set. The platform stack publishes this — was it deployed?" >&2
  exit 1
fi
EXISTING_NAT_STATE=$(aws ec2 describe-nat-gateways --nat-gateway-ids "$EXISTING_NAT_SSM" \
  --query "NatGateways[0].State" --output text 2>/dev/null || echo "missing")
if [[ "$EXISTING_NAT_STATE" != "available" ]]; then
  echo "ERROR: SSM $EDGE_NAT_SSM points at $EXISTING_NAT_SSM (state: $EXISTING_NAT_STATE), not a live NAT gateway." >&2
  echo "       The platform stack is stale — redeploy it to refresh the parameter." >&2
  exit 1
fi
echo ">>> SSM $EDGE_NAT_SSM points at live NAT gateway $EXISTING_NAT_SSM."

# ── Create shared IoT VPC destination (once) ────────────────────────────────
# //TODO - This should also be created in the platform stack
echo ">>> Creating/confirming IoT VPC destination..."
bash "$(dirname "$0")/create-iot-vpc-dest.sh"

# ── Resolve S3 bucket from CloudFormation export ─────────────────────────────
S3_BUCKET=$(aws cloudformation list-exports \
  --query "Exports[?Name=='workshop-platform-bucket-name'].Value" \
  --output text)

# ── Acquire + upload shared IoT Device Client binary to S3 ───────────────────
# Mirror scripts/sandbox.sh exactly (shared functions in build-device-client.sh
# so the two paths can't drift): fetch the pre-built GitHub Release asset first
# (Docker-free, no creds — works in CodeBuild), fall back to a local Docker
# build only if Docker is present, else fail with an actionable message.
#
# Previously this path merely checked for a pre-existing cache and warned+skipped
# if absent. Under the async orchestrator (CodeBuild) that cache is always empty,
# so the binary was never uploaded → edge instances never ran the Device Client
# → the K3s IoT Job never executed → the post-deploy tail timed out waiting 30
# min for the kubeconfig in SSM. Acquiring it here fixes the async deploy.
# shellcheck source=scripts/build-device-client.sh
source "$(dirname "$0")/build-device-client.sh"
# Provenance-suffixed cache key, matching sandbox.sh, so a stale binary from
# before a version/patch bump is never reused silently.
LOCAL_BINARY_CACHE="$HOME/.cache/workshop/aws-iot-device-client-${DEVICE_CLIENT_PROVENANCE}"
if [[ ! -f "$LOCAL_BINARY_CACHE" ]]; then
  echo ">>> Fetching pre-built IoT Device Client from GitHub Release ${DEVICE_CLIENT_RELEASE_TAG}…"
  if fetch_prebuilt_device_client "$LOCAL_BINARY_CACHE"; then
    echo ">>> Fetched pre-built binary → $LOCAL_BINARY_CACHE"
  elif command -v docker >/dev/null 2>&1; then
    echo ">>> No pre-built artifact available — building with Docker (one-time, ~8 min)…"
    build_device_client_binary "$LOCAL_BINARY_CACHE"
    echo ">>> Binary built and cached at $LOCAL_BINARY_CACHE"
  else
    echo "ERROR: could not obtain the aws-iot-device-client binary." >&2
    echo "  • No pre-built artifact at GitHub Release '${DEVICE_CLIENT_RELEASE_TAG}' (repo ${DEVICE_CLIENT_REPO})." >&2
    echo "  • Docker is not available, so the local cross-compile fallback can't run either." >&2
    echo "  Fix: publish the artifact via the 'Build Device Client' workflow" >&2
    echo "  (gh workflow run build-device-client.yml), then re-deploy." >&2
    exit 1
  fi
else
  echo ">>> Using cached IoT Device Client binary."
fi
echo ">>> Uploading IoT Device Client binary to s3://${S3_BUCKET}/bin/aws-iot-device-client..."
aws s3 cp "$LOCAL_BINARY_CACHE" "s3://${S3_BUCKET}/bin/aws-iot-device-client"

echo ">>> Uploading persistent MQTT telemetry publisher to s3://${S3_BUCKET}/bin/mqtt-publisher.py..."
aws s3 cp job-scripts/mqtt-publisher.py "s3://${S3_BUCKET}/bin/mqtt-publisher.py"

echo ">>> Uploading sensor simulator to s3://${S3_BUCKET}/simulator/sensor-sim.py..."
aws s3 cp simulator/sensor-sim.py "s3://${S3_BUCKET}/simulator/sensor-sim.py"
echo ">>> Uploading frac-op burst generator to s3://${S3_BUCKET}/simulator/frac-op-burst.py..."
aws s3 cp simulator/frac-op-burst.py "s3://${S3_BUCKET}/simulator/frac-op-burst.py"
echo ">>> Shared uploads complete."

# ── Per-slot post-deploy tail (parallel) ─────────────────────────────────────
# The single `cdk deploy` above already brought up every slot's nested
# Auth/Data/Participant stacks (epic #181). What remains per slot is the
# post-deploy tail — device self-registration wait, shadow seeding, K3s + cloud
# analytics pre-warm — factored into scripts/post-deploy-slot.sh so sandbox.sh
# and the CI orchestrator share the exact same steps. These are independent per
# slot, so run them concurrently.
MAX_PARALLEL="${SANDBOX_MAX_PARALLEL:-6}"
LOG_DIR=$(mktemp -d /tmp/sandbox-all-logs.XXXXXX)
echo ">>> Running post-deploy tail for ${#DEPLOYMENT_IDS[@]} slots in parallel (max ${MAX_PARALLEL} at once, logs in ${LOG_DIR})..."

_post_deploy_slot() {
  local id="$1"
  bash "$(dirname "$0")/post-deploy-slot.sh" "$id"
}

# bash 3.2 (macOS default) has no `wait -n`, so gate concurrency by polling a
# PID→slot map and reaping finished jobs until we're back under the cap.
declare -a PIDS=()
declare -a PID_IDS=()
FAILED=0

_reap_one() {
  # Block until at least one running job exits; record its status. Returns 1
  # only if there are no jobs to reap.
  [[ ${#PIDS[@]} -eq 0 ]] && return 1
  while true; do
    local i
    for i in "${!PIDS[@]}"; do
      if ! kill -0 "${PIDS[$i]}" 2>/dev/null; then
        local pid="${PIDS[$i]}" sid="${PID_IDS[$i]}" rc=0
        wait "$pid" || rc=$?
        unset 'PIDS[$i]' 'PID_IDS[$i]'
        # Re-index; guard the expansion because `set -u` errors on "${arr[@]}"
        # for an empty array under bash 3.2 (the macOS default).
        PIDS=(${PIDS[@]+"${PIDS[@]}"}); PID_IDS=(${PID_IDS[@]+"${PID_IDS[@]}"})
        if [[ $rc -eq 0 ]]; then
          echo ">>> [$sid] Post-deploy tail complete."
        else
          echo "ERROR: post-deploy tail for $sid failed (rc=$rc) — see ${LOG_DIR}/${sid}.log" >&2
          tail -n 25 "${LOG_DIR}/${sid}.log" | sed "s/^/    [$sid] /" >&2 || true
          FAILED=1
        fi
        return 0
      fi
    done
    sleep 2
  done
}

for ID in "${DEPLOYMENT_IDS[@]}"; do
  while [[ ${#PIDS[@]} -ge $MAX_PARALLEL ]]; do _reap_one; done
  echo ">>> [$ID] Starting post-deploy tail..."
  ( _post_deploy_slot "$ID" ) >"${LOG_DIR}/${ID}.log" 2>&1 &
  PIDS+=("$!")
  PID_IDS+=("$ID")
done

# Drain the rest.
while [[ ${#PIDS[@]} -gt 0 ]]; do _reap_one; done

if [[ $FAILED -eq 0 ]]; then
  echo ">>> All slots deployed. Generating deployment summary..."
  bash "$(dirname "$0")/deployment-summary.sh" "${DEPLOYMENT_IDS[@]}"
else
  echo ">>> One or more slots' post-deploy tail failed. Full logs retained in ${LOG_DIR}" >&2
fi

exit $FAILED
