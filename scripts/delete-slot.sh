#!/usr/bin/env bash
# delete-slot.sh — remove a SINGLE slot from the shared platform stack.
#
# Usage: scripts/delete-slot.sh <ws-slotNN> [--dry-run]
#
# WHY THIS IS NOT JUST `cdk destroy` (epic #180 / #181 / #184):
# A slot no longer has its own top-level stack. Its Auth/Data/Participant
# resources are NESTED stacks inside the single WorkshopPlatformStack, driven by
# the WORKSHOP_SLOTS list. So "delete one slot" = drop it from the active-slot
# set (scripts/slot-list.sh) and re-deploy the platform: CFN then removes that
# slot's three nested stacks and everything they manage, while every other slot
# and all shared infra (VPCs, EKS, MSK, Firehose, S3) stay put.
#
# The trade-off recorded in workshop/reference/decisions: we lose the old
# ability to `cdk destroy` one slot's top-level stack independently. In exchange
# the whole fleet is one deploy target. Removing a slot is now a platform UPDATE.
#
# ORDER MATTERS — runtime cleanup BEFORE the CFN update:
# Devices self-register at runtime via fleet provisioning (IoT things + certs
# that CFN never created), and each slot attaches a SCRAM secret + per-slot
# topics to the SHARED MSK cluster. If CFN tries to delete the slot's
# provisioning template / device policy while those runtime certs are still
# attached, the delete deadlocks (the documented DevicePolicy/claim-cert
# dead-lock). So we run scripts/teardown.sh FIRST to detach/delete the runtime
# artefacts, THEN drop the slot and update the platform so CFN can cleanly
# remove the (now unreferenced) nested stacks.

set -euo pipefail

DEPLOYMENT_ID=""
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    *)         DEPLOYMENT_ID="$arg" ;;
  esac
done

if [[ -z "$DEPLOYMENT_ID" ]]; then
  echo "Usage: $0 <ws-slotNN> [--dry-run]" >&2
  exit 1
fi

HERE="$(dirname "$0")"
PLATFORM_APP="npx tsx amplify/custom/platform-app.ts"
PLATFORM_STACK_NAME="WorkshopPlatformStack"

# shellcheck source=scripts/slot-list.sh
source "$HERE/slot-list.sh"

echo "=== Deleting slot $DEPLOYMENT_ID from $PLATFORM_STACK_NAME ==="

# ── 1. Runtime-artefact cleanup (must precede the CFN update) ─────────────────
# teardown.sh detaches/deletes the self-registered IoT things+certs, the slot's
# SCRAM secret association + per-slot topics on the shared MSK cluster, the EKS
# namespace, and the K3s SSM params. It is idempotent and `|| true`s everything,
# so any resource CFN also owns (and will remove in step 3) is a harmless no-op
# here. --dry-run is passed straight through.
TEARDOWN_ARGS=(--deployment-id "$DEPLOYMENT_ID")
$DRY_RUN && TEARDOWN_ARGS+=(--dry-run)
echo ">>> Running runtime cleanup (scripts/teardown.sh)..."
bash "$HERE/teardown.sh" "${TEARDOWN_ARGS[@]}"

# ── 2. Drop the slot from the persisted active-slot set ──────────────────────
if $DRY_RUN; then
  REMAINING=$(slots_get)
  # comm-based removal without persisting, just to preview.
  REMAINING=$(printf '%s\n' "$REMAINING" | tr ',' '\n' | grep -vx "$DEPLOYMENT_ID" | paste -sd, -)
  echo "DRY-RUN: would set active slots to: ${REMAINING:-<empty>}"
else
  REMAINING=$(slots_remove "$DEPLOYMENT_ID")
  echo ">>> Active slot set is now: ${REMAINING:-<empty>}"
fi

# ── 3. Re-deploy the platform with the slot removed ──────────────────────────
# CFN diffs the template (which no longer contains this slot's nested stacks)
# and deletes them. Every other slot + all shared infra is untouched.
: "${CDK_DEFAULT_ACCOUNT:=$(aws sts get-caller-identity --query Account --output text)}"
CDK_DEFAULT_REGION="${CDK_DEFAULT_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region || echo us-east-1)}}"
export CDK_DEFAULT_ACCOUNT CDK_DEFAULT_REGION

if $DRY_RUN; then
  echo "DRY-RUN: would run: WORKSHOP_SLOTS=\"${REMAINING}\" npx cdk deploy --app \"$PLATFORM_APP\" $PLATFORM_STACK_NAME"
else
  echo ">>> Updating $PLATFORM_STACK_NAME with remaining slots: ${REMAINING:-<none>}..."
  WORKSHOP_SLOTS="$REMAINING" npx cdk deploy \
    --app "$PLATFORM_APP" \
    --require-approval never \
    "$PLATFORM_STACK_NAME"
fi

echo "=== Slot $DEPLOYMENT_ID removed. Shared platform + other slots preserved. ==="
