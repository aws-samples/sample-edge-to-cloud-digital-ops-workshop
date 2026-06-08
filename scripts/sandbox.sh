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

# ── Start Amplify sandbox for this participant ───────────────────────────────
export WORKSHOP_DEPLOYMENT_ID="$DEPLOYMENT_ID"
echo ">>> Starting Amplify sandbox --identifier $DEPLOYMENT_ID"
exec npx ampx sandbox --identifier "$DEPLOYMENT_ID"
