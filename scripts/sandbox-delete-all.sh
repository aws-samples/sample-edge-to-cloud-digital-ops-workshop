#!/usr/bin/env bash
# Usage: ./scripts/sandbox-delete-all.sh [ws-slot00 ws-slot01 ...]
#
# Tears down EVERYTHING: every slot's runtime artefacts, then the single shared
# WorkshopPlatformStack (VPCs, EKS, MSK, Firehose, S3 — and, as nested stacks,
# every slot's Auth/Data/Participant resources).
#
# Since epic #180 / #181 there are no per-slot top-level stacks or per-slot
# Amplify sandboxes to delete — a slot's CFN resources are NESTED inside the
# platform stack, so `cdk destroy WorkshopPlatformStack` cascades and removes
# them all. What CFN can't remove on its own is the RUNTIME state each slot
# accreted: self-registered IoT things+certs (fleet provisioning created them,
# not CFN), the slot's SCRAM secret association + per-slot topics on the shared
# MSK cluster, and the EKS namespace. Those must be cleaned first (scripts/
# teardown.sh) or the nested-stack delete deadlocks on attached certs.
#
# If no slot ids are given, the active-slot set persisted in SSM
# (/workshop/platform/active-slots, see scripts/slot-list.sh) is used — that is
# the authoritative list of what the platform stack currently contains.

set -euo pipefail

HERE="$(dirname "$0")"
PLATFORM_STACK="WorkshopPlatformStack"
PLATFORM_APP="npx tsx amplify/custom/platform-app.ts"

# shellcheck source=scripts/slot-list.sh
source "$HERE/slot-list.sh"

DEPLOYMENT_IDS=("$@")
if [[ ${#DEPLOYMENT_IDS[@]} -eq 0 ]]; then
  echo ">>> No slots given — using persisted active-slot set from SSM."
  CURRENT=$(slots_get)
  if [[ -n "$CURRENT" ]]; then
    IFS=',' read -r -a DEPLOYMENT_IDS <<< "$CURRENT"
  fi
fi
echo ">>> Slots to tear down: ${DEPLOYMENT_IDS[*]:-<none — platform only>}"

# ── 1. Per-slot runtime cleanup (parallel) ───────────────────────────────────
# teardown.sh detaches/deletes self-registered IoT things+certs, disassociates
# the slot's SCRAM secret + deletes per-slot topics on the shared MSK cluster,
# and deletes the EKS namespace — the runtime state CFN can't reclaim itself.
if [[ ${#DEPLOYMENT_IDS[@]} -gt 0 ]]; then
  echo ">>> Cleaning up runtime artefacts for ${#DEPLOYMENT_IDS[@]} slot(s) in parallel..."
  PIDS=()
  for ID in "${DEPLOYMENT_IDS[@]}"; do
    bash "$HERE/teardown.sh" --deployment-id "$ID" \
      > >(sed "s/^/[$ID] /") 2> >(sed "s/^/[$ID] /" >&2) &
    PIDS+=($!)
    echo ">>> [$ID] runtime cleanup started (pid $!)"
  done
  for i in "${!PIDS[@]}"; do
    wait "${PIDS[$i]}" || echo "WARNING: runtime cleanup for ${DEPLOYMENT_IDS[$i]} returned non-zero (continuing)." >&2
  done
  echo ">>> Runtime cleanup complete."
fi

# ── 2. Clear the persisted active-slot set ───────────────────────────────────
# The platform is about to be destroyed entirely, so the list must be empty —
# otherwise a later `sandbox:all` with no args would think slots still exist.
echo ">>> Clearing active-slot set..."
slots_put "" >/dev/null || true

# ── 3. Destroy the platform stack (cascades all nested slot stacks) ──────────
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

echo ">>> Destroying $PLATFORM_STACK (and every slot's nested stacks)..."
npx cdk destroy \
  --app "$PLATFORM_APP" \
  --require-approval never \
  --force \
  "$PLATFORM_STACK"

echo ">>> Done. All workshop resources removed."
