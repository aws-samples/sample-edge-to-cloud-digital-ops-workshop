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

# ── Fan out one Amplify sandbox per participant (parallel) ───────────────────
echo ">>> Starting ${#DEPLOYMENT_IDS[@]} sandboxes in parallel..."

PIDS=()
for ID in "${DEPLOYMENT_IDS[@]}"; do
  bash -c '
    . "$HOME/.nvm/nvm.sh"
    nvm use 22 --silent
    WORKSHOP_DEPLOYMENT_ID="'"$ID"'" npx ampx sandbox --identifier "'"$ID"'" --once
  ' > >(sed "s/^/[$ID] /") \
    2> >(sed "s/^/[$ID] /" >&2) &
  PIDS+=($!)
  echo ">>> [$ID] sandbox started (pid $!)"
done

# Wait for all and surface any failures
FAILED=0
for i in "${!PIDS[@]}"; do
  if ! wait "${PIDS[$i]}"; then
    echo "ERROR: sandbox for ${DEPLOYMENT_IDS[$i]} failed" >&2
    FAILED=1
  fi
done

exit $FAILED
