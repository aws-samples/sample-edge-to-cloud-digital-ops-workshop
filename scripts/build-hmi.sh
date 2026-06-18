#!/usr/bin/env bash
# Usage: ./scripts/build-hmi.sh [--deployment-id <id>]
#   --deployment-id defaults to ws-slot00
#
# Builds the Next.js HMI Docker image from hmi/, uploads it to S3, then
# imports it into every K3s edge EC2 node (tagged *edge-[0-2]) via SSM.

set -euo pipefail
trap 'rm -f /tmp/ssm-params-*.json' EXIT

# ── Parse arguments ──────────────────────────────────────────────────────────
DEPLOYMENT_ID="ws-slot00"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deployment-id)
      DEPLOYMENT_ID="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: $0 [--deployment-id <id>]"
      exit 1
      ;;
  esac
done

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
S3_BUCKET="workshop-${DEPLOYMENT_ID}-${ACCOUNT_ID}"
IMAGE_TAG="workshop-hmi:latest"
LOCAL_TARBALL="/tmp/workshop-hmi.tar.gz"
S3_KEY="images/workshop-hmi.tar.gz"

echo ">>> Deployment ID : $DEPLOYMENT_ID"
echo ">>> S3 bucket     : s3://${S3_BUCKET}/${S3_KEY}"

# ── 1. Build the Docker image ────────────────────────────────────────────────
echo ">>> Building Docker image ${IMAGE_TAG} from ./hmi …"
docker buildx build --platform linux/amd64 -t "${IMAGE_TAG}" ./hmi --load
echo ">>> Docker image built."

# ── 2. Save and compress the image ──────────────────────────────────────────
echo ">>> Saving image to ${LOCAL_TARBALL} …"
docker save "${IMAGE_TAG}" | gzip > "${LOCAL_TARBALL}"
echo ">>> Image saved ($(du -sh "${LOCAL_TARBALL}" | cut -f1))."

# ── 3. Upload to S3 ──────────────────────────────────────────────────────────
echo ">>> Uploading to s3://${S3_BUCKET}/${S3_KEY} …"
aws s3 cp "${LOCAL_TARBALL}" "s3://${S3_BUCKET}/${S3_KEY}"
echo ">>> Upload complete."

# ── 4. Find K3s edge instance IDs (exclude sensor-sim) ──────────────────────
echo ">>> Looking up K3s edge instances tagged WorkshopDeploymentId=${DEPLOYMENT_ID} …"

INSTANCE_IDS=$(aws ec2 describe-instances \
  --filters \
    "Name=tag:WorkshopDeploymentId,Values=${DEPLOYMENT_ID}" \
    "Name=tag:Name,Values=*edge-?" \
    "Name=instance-state-name,Values=running" \
  --query "Reservations[].Instances[].InstanceId" \
  --output text)

if [[ -z "${INSTANCE_IDS}" ]]; then
  echo "ERROR: No running edge instances found for deployment '${DEPLOYMENT_ID}'."
  exit 1
fi

echo ">>> Found instances: ${INSTANCE_IDS}"

# ── 5. Import image on each instance via SSM ────────────────────────────────
SSM_PARAMS_FILE=$(mktemp /tmp/ssm-params-XXXXXX.json)
# Write parameters JSON to a temp file to preserve newlines/special chars
python3 -c "
import json, sys
cmd = 'aws s3 cp s3://${S3_BUCKET}/images/workshop-hmi.tar.gz /tmp/hmi.tar.gz && k3s ctr images import /tmp/hmi.tar.gz && rm /tmp/hmi.tar.gz'
print(json.dumps({'commands': [cmd]}))
" > "${SSM_PARAMS_FILE}"

OVERALL_SUCCESS=true

for INSTANCE_ID in ${INSTANCE_IDS}; do
  echo "---"
  echo ">>> Sending SSM command to ${INSTANCE_ID} …"

  COMMAND_ID=$(aws ssm send-command \
    --instance-ids "${INSTANCE_ID}" \
    --document-name "AWS-RunShellScript" \
    --parameters "file://${SSM_PARAMS_FILE}" \
    --comment "Import workshop-hmi image" \
    --query "Command.CommandId" \
    --output text)

  echo ">>> Command ID: ${COMMAND_ID}"

  # ── Poll until the command finishes ────────────────────────────────────────
  echo ">>> Waiting for command to complete …"
  while true; do
    STATUS=$(aws ssm get-command-invocation \
      --command-id "${COMMAND_ID}" \
      --instance-id "${INSTANCE_ID}" \
      --query "Status" \
      --output text 2>/dev/null || echo "Pending")

    case "${STATUS}" in
      Success)
        echo ">>> [${INSTANCE_ID}] SUCCESS"
        break
        ;;
      Failed|Cancelled|TimedOut|Undeliverable|Terminated)
        echo ">>> [${INSTANCE_ID}] FAILED (status: ${STATUS})"
        # Print stdout/stderr for diagnosis
        aws ssm get-command-invocation \
          --command-id "${COMMAND_ID}" \
          --instance-id "${INSTANCE_ID}" \
          --query "[StandardOutputContent, StandardErrorContent]" \
          --output text || true
        OVERALL_SUCCESS=false
        break
        ;;
      Pending|InProgress|Delayed)
        # Still running — wait before polling again
        sleep 5
        ;;
      *)
        echo ">>> [${INSTANCE_ID}] Unknown status '${STATUS}', continuing to poll …"
        sleep 5
        ;;
    esac
  done
done

echo "---"
if [[ "${OVERALL_SUCCESS}" == "true" ]]; then
  echo ">>> All instances updated successfully."
else
  echo ">>> One or more instances failed. Review the output above."
  exit 1
fi
