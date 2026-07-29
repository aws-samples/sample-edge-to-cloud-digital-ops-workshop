#!/usr/bin/env bash
# Usage: ./scripts/sandbox-delete-all.sh ws-a1b2c3 ws-b4c5d6 [...]
#   Deletes each participant's Amplify sandbox in parallel, then destroys
#   WorkshopPlatformStack (shared VPCs).

set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 <deployment-id> [deployment-id ...]" >&2
  exit 1
fi

DEPLOYMENT_IDS=("$@")
PLATFORM_STACK="WorkshopPlatformStack"
PLATFORM_APP="npx tsx amplify/custom/platform-app.ts"

# ── Delete any per-slot MSK clusters left over from older deployments ────────
# The shared platform MSK cluster is destroyed automatically by the
# `cdk destroy` below; this only cleans up legacy per-slot clusters if present.
echo ">>> Deleting MSK clusters for all deployment IDs..."
MSK_PIDS=()
for ID in "${DEPLOYMENT_IDS[@]}"; do
  (
    MSK_ARN=$(aws kafka list-clusters-v2 \
      --query "ClusterInfoList[?ClusterName=='workshop-${ID}-msk'].ClusterArn" \
      --output text 2>/dev/null)
    if [[ -z "$MSK_ARN" || "$MSK_ARN" == "None" ]]; then
      echo ">>> [$ID] No MSK cluster found, skipping."
      exit 0
    fi
    STATE=$(aws kafka describe-cluster-v2 --cluster-arn "$MSK_ARN" \
      --query "ClusterInfo.State" --output text 2>/dev/null || echo "UNKNOWN")
    if [[ "$STATE" == "DELETING" ]]; then
      echo ">>> [$ID] MSK already deleting."
    elif [[ "$STATE" != "UNKNOWN" ]]; then
      echo ">>> [$ID] Deleting MSK cluster ($STATE)..."
      aws kafka delete-cluster --cluster-arn "$MSK_ARN" > /dev/null
    fi
    echo ">>> [$ID] Waiting for MSK to finish deleting..."
    while true; do
      S=$(aws kafka describe-cluster-v2 --cluster-arn "$MSK_ARN" \
        --query "ClusterInfo.State" --output text 2>&1)
      [[ "$S" == *"NotFoundException"* || "$S" == *"does not exist"* ]] && break
      echo ">>> [$ID] MSK: $S"
      sleep 30
    done
    echo ">>> [$ID] MSK deleted."
  ) &
  MSK_PIDS+=($!)
done
for pid in "${MSK_PIDS[@]}"; do wait "$pid" || true; done
echo ">>> All MSK clusters deleted."

# ── Delete participant sandboxes in parallel ─────────────────────────────────
echo ">>> Deleting ${#DEPLOYMENT_IDS[@]} sandboxes in parallel..."

PIDS=()
for ID in "${DEPLOYMENT_IDS[@]}"; do
  bash -c '
    . "$HOME/.nvm/nvm.sh"
    nvm use 22 --silent
    WORKSHOP_DEPLOYMENT_ID="'"$ID"'" npx ampx sandbox delete --identifier "'"$ID"'" --yes
  ' > >(sed "s/^/[$ID] /") \
    2> >(sed "s/^/[$ID] /" >&2) &
  PIDS+=($!)
  echo ">>> [$ID] delete started (pid $!)"
done

FAILED=0
for i in "${!PIDS[@]}"; do
  if ! wait "${PIDS[$i]}"; then
    echo "ERROR: sandbox delete for ${DEPLOYMENT_IDS[$i]} failed" >&2
    FAILED=1
  fi
done

if [[ $FAILED -ne 0 ]]; then
  echo "ERROR: one or more sandbox deletes failed — aborting platform stack destroy" >&2
  exit 1
fi

echo ">>> All sandboxes deleted."

# ── Destroy platform stack ───────────────────────────────────────────────────
STACK_STATUS=$(aws cloudformation describe-stacks \
  --stack-name "$PLATFORM_STACK" \
  --query "Stacks[0].StackStatus" \
  --output text 2>/dev/null || echo "DOES_NOT_EXIST")

if [[ "$STACK_STATUS" == "DOES_NOT_EXIST" ]]; then
  echo ">>> Platform stack not found, nothing to destroy."
  exit 0
fi

# Empty the shared bucket first. Its `autoDeleteObjects` Lambda times out paging
# a large bucket during `cdk destroy`, leaving the stack DELETE_FAILED (#111).
# Clearing it up front from the CLI (which pages without a Lambda timeout) makes
# the auto-delete custom resource a no-op. Belt-and-braces alongside the CDK
# lifecycle rules that keep the bucket small in the first place.
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)
SHARED_BUCKET="workshop-platform-${ACCOUNT_ID}"
if [[ -n "$ACCOUNT_ID" ]] && aws s3api head-bucket --bucket "$SHARED_BUCKET" 2>/dev/null; then
  echo ">>> Emptying shared bucket $SHARED_BUCKET before destroy..."
  aws s3 rm "s3://${SHARED_BUCKET}" --recursive || true
fi

echo ">>> Destroying $PLATFORM_STACK..."
npx cdk destroy \
  --app "$PLATFORM_APP" \
  --require-approval never \
  --force \
  "$PLATFORM_STACK"

echo ">>> Done. All workshop resources removed."
