#!/usr/bin/env bash
# Usage: ./scripts/sandbox-all.sh ws-a1b2c3 ws-b4c5d6 [...]
#   Deploys the shared platform stack once (if needed), then starts an
#   Amplify sandbox for each deployment ID in parallel.

set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 <deployment-id> [deployment-id ...]" >&2
  exit 1
fi

DEPLOYMENT_IDS=("$@")
PLATFORM_APP="npx tsx amplify/custom/platform-app.ts"

# ── Ensure shared VPCs exist (sequential, safe) ───────────────────────────────
# Check by VPC name — the platform stack may have been deployed standalone or
# as a nested stack inside an Amplify sandbox; the VPC names are stable either way.
EDGE_VPC_ID=$(aws ec2 describe-vpcs \
  --filters "Name=tag:Name,Values=workshop-edge" \
  --query "Vpcs[0].VpcId" \
  --output text 2>/dev/null || echo "None")

if [[ "$EDGE_VPC_ID" != "None" && -n "$EDGE_VPC_ID" ]]; then
  echo ">>> Shared VPCs found ($EDGE_VPC_ID). Skipping platform deploy."
else
  echo ">>> Shared VPCs not found. Deploying platform stack (one-time step)..."
  npx cdk deploy \
    --app "$PLATFORM_APP" \
    --require-approval never \
    "WorkshopPlatformStack"
  echo ">>> Platform stack deployed."
fi

# ── Create shared IoT VPC destination (once) ────────────────────────────────
# CfnTopicRuleDestination can't be confirmed inside CloudFormation's timeout,
# so we create + confirm it here and store the ARN in SSM.
echo ">>> Creating/confirming IoT VPC destination..."
bash "$(dirname "$0")/create-iot-vpc-dest.sh"

# ── Upload shared binaries and simulator to S3 (once per platform bucket) ────
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
S3_BUCKET="workshop-platform-${ACCOUNT_ID}"
LOCAL_BINARY_CACHE="$HOME/.cache/workshop/aws-iot-device-client"

if [[ -f "$LOCAL_BINARY_CACHE" ]]; then
  echo ">>> Uploading IoT Device Client binary to s3://${S3_BUCKET}/bin/aws-iot-device-client…"
  aws s3 cp "$LOCAL_BINARY_CACHE" "s3://${S3_BUCKET}/bin/aws-iot-device-client"
else
  echo ">>> WARNING: IoT Device Client binary not found at $LOCAL_BINARY_CACHE — run scripts/sandbox.sh once to build it"
fi

echo ">>> Uploading sensor simulator to s3://${S3_BUCKET}/simulator/sensor-sim.py…"
aws s3 cp simulator/sensor-sim.py "s3://${S3_BUCKET}/simulator/sensor-sim.py"
echo ">>> Shared uploads complete."

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
