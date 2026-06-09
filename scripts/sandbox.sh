#!/usr/bin/env bash
# Usage: ./scripts/sandbox.sh [deployment-id]
#   deployment-id defaults to ws-slot00
#
# Checks whether WorkshopPlatformStack is deployed (or in progress).
# If not, deploys it first. Then starts the Amplify sandbox for this participant.

set -euo pipefail

DEPLOYMENT_ID="${1:-ws-slot00}"
PLATFORM_APP="npx tsx amplify/custom/platform-app.ts"

echo ">>> Deployment ID: $DEPLOYMENT_ID"

# ── Check whether the shared VPCs exist ─────────────────────────────────────
# The platform stack may have been deployed as a standalone stack OR as a
# nested stack inside an Amplify sandbox — either way the VPC names are stable.
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

# ── Build IoT Device Client binary and stage to S3 ──────────────────────────
# Uses the official GHCR build image so EC2 user data only needs a fast S3 download.
# The binary is cached locally after the first build; subsequent runs skip the build step.
LOCAL_BINARY_CACHE="$HOME/.cache/workshop/aws-iot-device-client"
S3_BUCKET="workshop-${DEPLOYMENT_ID}"

if [[ ! -f "$LOCAL_BINARY_CACHE" ]]; then
  echo ">>> Building AWS IoT Device Client using the official GHCR build image (one-time, ~8 min)…"
  DC_SRC=$(mktemp -d)
  git clone --depth 1 --branch v1.10.1 \
    https://github.com/awslabs/aws-iot-device-client "$DC_SRC"
  docker pull ghcr.io/awslabs/aws-iot-device-client/amazonlinux:latest
  docker run --rm \
    -v "$DC_SRC:/root/aws-iot-device-client" \
    ghcr.io/awslabs/aws-iot-device-client/amazonlinux:latest
  mkdir -p "$(dirname "$LOCAL_BINARY_CACHE")"
  cp "$DC_SRC/build/aws-iot-device-client" "$LOCAL_BINARY_CACHE"
  rm -rf "$DC_SRC"
  echo ">>> Binary cached at $LOCAL_BINARY_CACHE"
else
  echo ">>> Using cached IoT Device Client binary."
fi

# ── Start Amplify sandbox for this participant ───────────────────────────────
export WORKSHOP_DEPLOYMENT_ID="$DEPLOYMENT_ID"
echo ">>> Starting Amplify sandbox --identifier $DEPLOYMENT_ID"
. "$HOME/.nvm/nvm.sh"
nvm use 22 --silent
npx ampx sandbox --identifier "$DEPLOYMENT_ID" --once

# ── Upload binary to S3 after CDK creates the bucket ────────────────────────
echo ">>> Uploading IoT Device Client binary to s3://${S3_BUCKET}/bin/aws-iot-device-client…"
aws s3 cp "$LOCAL_BINARY_CACHE" "s3://${S3_BUCKET}/bin/aws-iot-device-client"
echo ">>> Upload complete."
