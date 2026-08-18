#!/usr/bin/env bash
# Usage: ./scripts/sandbox.sh [--force] [deployment-id]
#   deployment-id defaults to ws-slot00
#   --force is accepted for back-compat but is now a no-op: since epic #180/#181
#     the single WorkshopPlatformStack deploy is always run (it's idempotent and
#     is also what adds this slot's nested stacks), so there is no health-check
#     to bypass.
#
# Since epic #180/#181 there is no separate per-slot Amplify sandbox. This slot's
# auth/data/participant resources are NESTED stacks inside the one shared
# WorkshopPlatformStack, driven by the WORKSHOP_SLOTS list. This script:
#   1. merges this slot into the persisted active-slot set (scripts/slot-list.sh)
#   2. runs the single `cdk deploy` of WorkshopPlatformStack for the whole set
#      (idempotent — brings up / updates every slot's nested stacks)
#   3. stages the IoT Device Client binary + simulator to the shared S3 bucket
#   4. runs the per-slot post-deploy tail (scripts/post-deploy-slot.sh)

set -euo pipefail

FORCE=false
DEPLOYMENT_ID="ws-slot00"
for arg in "$@"; do
  if [[ "$arg" == "--force" ]]; then
    FORCE=true  # retained for CLI back-compat; no longer gates anything
  else
    DEPLOYMENT_ID="$arg"
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
  # Is the parameter already a resource of the platform stack? If so, leave it.
  if aws cloudformation describe-stack-resources --stack-name "$stack_name" \
      --query "StackResources[?ResourceType=='AWS::SSM::Parameter'].PhysicalResourceId" \
      --output text 2>/dev/null | grep -qx "$param"; then
    return 0
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
  # Is the database already a resource of the platform stack? If so, leave it.
  if aws cloudformation describe-stack-resources --stack-name "$stack_name" \
      --query "StackResources[?ResourceType=='AWS::Glue::Database'].PhysicalResourceId" \
      --output text 2>/dev/null | grep -qx "$db"; then
    return 0
  fi
  echo ">>> Deleting orphaned Glue table/database $db.$table (not stack-managed) before platform deploy."
  aws glue delete-table --database-name "$db" --name "$table" >/dev/null 2>&1 || true
  aws glue delete-database --name "$db" >/dev/null 2>&1 || true
}

echo ">>> Deployment ID: $DEPLOYMENT_ID"

# ── Merge this slot into the persisted active-slot set (#180/#181/#184) ──────
# The platform stack is now ONE stack whose per-slot nested stacks are driven by
# WORKSHOP_SLOTS; that list is authoritative, so a deploy that omitted a slot
# would tear it down. Union this slot with the already-active set so bringing up
# one slot never drops the others. See scripts/slot-list.sh.
# shellcheck source=scripts/slot-list.sh
source "$(dirname "$0")/slot-list.sh"
ALL_SLOTS=$(slots_add "$DEPLOYMENT_ID")
echo ">>> Active slot set is now: ${ALL_SLOTS}"

# ── Acquire the IoT Device Client binary ─────────────────────────────────────
# Pure local acquire/build — no dependency on the platform stack, so this runs
# before the deploy. It is cached locally after the first acquire; subsequent
# runs skip both fetch and build.
#
# TWO acquisition paths (issue #173). Docker is NOT available everywhere this
# script runs (e.g. AgentCore Runtime sessions have no docker binary or daemon),
# so we PREFER a pre-built artifact and only fall back to the local Docker
# compile:
#   1. fetch  — download the binary CI published to a GitHub Release
#               (build-device-client.yml). No Docker, no AWS creds needed.
#   2. build  — the original cross-compile inside amazonlinux:2023 (Docker).
# If neither is possible, fail with an actionable message pointing at the
# workflow. The version pin + #166 keep-alive patch (provenance) and both
# acquisition functions live in scripts/build-device-client.sh so the two paths
# can never drift.
# shellcheck source=scripts/build-device-client.sh
source "$(dirname "$0")/build-device-client.sh"
# Cache key encodes the provenance so a pre-existing cached binary from before
# a version/patch bump is never reused silently.
LOCAL_BINARY_CACHE="$HOME/.cache/workshop/aws-iot-device-client-${DEVICE_CLIENT_PROVENANCE}"

if [[ ! -f "$LOCAL_BINARY_CACHE" ]]; then
  # 1. Try the pre-built artifact first (the Docker-free path).
  echo ">>> Fetching pre-built IoT Device Client from GitHub Release ${DEVICE_CLIENT_RELEASE_TAG}…"
  if fetch_prebuilt_device_client "$LOCAL_BINARY_CACHE"; then
    echo ">>> Fetched pre-built binary → $LOCAL_BINARY_CACHE"
  # 2. Fall back to the local Docker compile only if Docker is available.
  elif command -v docker >/dev/null 2>&1; then
    echo ">>> No pre-built artifact available — building with Docker (ECR Public amazonlinux, one-time, ~8 min)…"
    build_device_client_binary "$LOCAL_BINARY_CACHE"
    echo ">>> Binary built and cached at $LOCAL_BINARY_CACHE"
  # 3. Neither path is possible — fail with an actionable message.
  else
    echo "ERROR: could not obtain the aws-iot-device-client binary." >&2
    echo "  • No pre-built artifact was found at GitHub Release '${DEVICE_CLIENT_RELEASE_TAG}'" >&2
    echo "    (repo ${DEVICE_CLIENT_REPO})." >&2
    echo "  • Docker is not available on this host, so the local cross-compile" >&2
    echo "    fallback cannot run either." >&2
    echo "" >&2
    echo "  Fix: publish the artifact by running the 'Build Device Client'" >&2
    echo "  GitHub Actions workflow (.github/workflows/build-device-client.yml)" >&2
    echo "  — e.g. 'gh workflow run build-device-client.yml' — then re-run this" >&2
    echo "  script. On a Docker-capable host you can instead just install Docker" >&2
    echo "  and re-run to build locally." >&2
    exit 1
  fi
else
  echo ">>> Using cached IoT Device Client binary."
fi

# ── Stage boot-time artifacts to the shared S3 bucket ────────────────────────
# #248: EC2 UserData downloads these at boot. Uploading them only AFTER the
# `cdk deploy` below (which is what boots the instances) raced freshly-launched
# instances' UserData — observed live on ws-slot42: instances up 19:04 UTC,
# mqtt-publisher.py uploaded 19:06 UTC, so the boot-time download 404'd and the
# persistent MQTT publisher never installed. Stage now, before the deploy,
# whenever the platform bucket already exists (the common redeploy case) so
# there is no race at all. On a brand-new account the bucket doesn't exist
# until this deploy creates it; STAGED_BEFORE_DEPLOY records whether we managed
# to stage now so the fallback after the deploy runs exactly once, not twice.
resolve_s3_bucket() {
  aws cloudformation list-exports \
    --query "Exports[?Name=='workshop-platform-bucket-name'].Value" \
    --output text 2>/dev/null
}

upload_boot_artifacts() {
  local bucket="$1"
  echo ">>> Uploading IoT Device Client binary to s3://${bucket}/bin/aws-iot-device-client…"
  aws s3 cp "$LOCAL_BINARY_CACHE" "s3://${bucket}/bin/aws-iot-device-client"

  echo ">>> Uploading persistent MQTT telemetry publisher to s3://${bucket}/bin/mqtt-publisher.py…"
  aws s3 cp job-scripts/mqtt-publisher.py "s3://${bucket}/bin/mqtt-publisher.py"

  echo ">>> Uploading sensor simulator to s3://${bucket}/simulator/sensor-sim.py…"
  aws s3 cp simulator/sensor-sim.py "s3://${bucket}/simulator/sensor-sim.py"

  echo ">>> Uploading frac-op burst generator to s3://${bucket}/simulator/frac-op-burst.py…"
  aws s3 cp simulator/frac-op-burst.py "s3://${bucket}/simulator/frac-op-burst.py"
}

S3_BUCKET=$(resolve_s3_bucket)
STAGED_BEFORE_DEPLOY=false
if [[ -n "$S3_BUCKET" && "$S3_BUCKET" != "None" ]]; then
  echo ">>> Platform bucket already exists ($S3_BUCKET) — staging boot-time artifacts before deploy (#248)."
  upload_boot_artifacts "$S3_BUCKET"
  STAGED_BEFORE_DEPLOY=true
else
  echo ">>> Platform bucket does not exist yet (first-ever deploy) — staging boot-time artifacts right after the deploy below creates it."
fi

# ── Deploy the platform stack (always — brings up this slot's nested stacks) ──
# cdk deploy is idempotent: if nothing changed it finishes in seconds. Since the
# slot's auth/data/participant resources are nested inside WorkshopPlatformStack
# (epic #181), this single deploy is what creates/updates them — there is no
# longer a separate `ampx sandbox` step. (--force is now a no-op: the deploy is
# unconditional and idempotent, so there's no health check to skip.)
#
# The platform stack now owns the /workshop/platform/edge-nat-gateway-id SSM
# parameter and the workshop_telemetry Glue database/table (see platform-stack.ts
# and #128). On accounts first provisioned by an older stack these can exist as
# out-of-band orphans; CFN can't *create* a managed resource on top of an
# unmanaged one, so delete the orphan first (but never one already CFN-managed).
ensure_no_orphan_nat_ssm "$PLATFORM_STACK_NAME"
ensure_no_orphan_glue_telemetry_table "$PLATFORM_STACK_NAME"

: "${CDK_DEFAULT_ACCOUNT:=$(aws sts get-caller-identity --query Account --output text)}"
CDK_DEFAULT_REGION="${CDK_DEFAULT_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region || echo us-east-1)}}"
export CDK_DEFAULT_ACCOUNT CDK_DEFAULT_REGION

echo ">>> Deploying $PLATFORM_STACK_NAME (platform + all ${ALL_SLOTS} slots as nested stacks)..."
WORKSHOP_SLOTS="$ALL_SLOTS" npx cdk deploy \
  --app "$PLATFORM_APP" \
  --require-approval never \
  "$PLATFORM_STACK_NAME"
echo ">>> Platform stack + all slots deployed."

# ── Verify edge NAT gateway ID in SSM ────────────────────────────────────────
# The platform stack publishes /workshop/platform/edge-nat-gateway-id (tied to
# the NAT gateway's lifecycle, so it's always fresh). ParticipantStack reads it.
# This is a read-only sanity check — the script no longer writes the value.
EDGE_NAT_SSM="/workshop/platform/edge-nat-gateway-id"
EXISTING_NAT_SSM=$(aws ssm get-parameter --name "$EDGE_NAT_SSM" --query "Parameter.Value" --output text 2>/dev/null || echo "None")
if [[ "$EXISTING_NAT_SSM" == "None" || -z "$EXISTING_NAT_SSM" ]]; then
  echo "ERROR: SSM $EDGE_NAT_SSM is not set. Deploy the platform stack (it publishes this)." >&2
  exit 1
fi
EXISTING_NAT_STATE=$(aws ec2 describe-nat-gateways --nat-gateway-ids "$EXISTING_NAT_SSM" \
  --query "NatGateways[0].State" --output text 2>/dev/null || echo "missing")
if [[ "$EXISTING_NAT_STATE" != "available" ]]; then
  echo "ERROR: SSM $EDGE_NAT_SSM points at $EXISTING_NAT_SSM (state: $EXISTING_NAT_STATE), not a live NAT gateway." >&2
  echo "       The platform stack is stale — redeploy it with: $0 --force ${DEPLOYMENT_ID}" >&2
  exit 1
fi
echo ">>> SSM $EDGE_NAT_SSM points at live NAT gateway $EXISTING_NAT_SSM."

# ── Stage boot-time artifacts (fallback: first-ever deploy) ──────────────────
# The bucket didn't exist when we checked above, so it's a resource of the
# deploy that just ran. Stage now — this is still before any *slot* is added
# in a later run, but on this very first deploy the instances just launched
# by the deploy above are already retrying the S3 download with backoff
# (participant-stack.ts UserData, #248), so a short window here is safe.
if [[ "$STAGED_BEFORE_DEPLOY" != true ]]; then
  S3_BUCKET=$(resolve_s3_bucket)
  if [[ -z "$S3_BUCKET" || "$S3_BUCKET" == "None" ]]; then
    echo "ERROR: could not resolve the workshop-platform-bucket-name export after deploying $PLATFORM_STACK_NAME." >&2
    exit 1
  fi
  upload_boot_artifacts "$S3_BUCKET"
fi
echo ">>> Upload complete."

# ── Per-slot post-deploy tail ────────────────────────────────────────────────
# Device self-registration wait, shadow seeding, K3s pre-warm. Factored into
# scripts/post-deploy-slot.sh so sandbox.sh, sandbox-all.sh and the CI
# orchestrator all run the identical steps. Idempotent.
#
# #253: cloud-analytics is now ONE shared release for the whole workshop, not
# part of this per-slot tail — deploy/redeploy it separately, once per
# account, with `scripts/deploy-cloud-analytics.sh --shared`
# (scripts/sandbox-all.sh does this automatically when bringing up multiple
# slots; a single `sandbox.sh` run assumes it already exists).
bash "$(dirname "$0")/post-deploy-slot.sh" "$DEPLOYMENT_ID"

# ── Write deployment summary ──────────────────────────────────────────────────
echo ">>> Generating deployment summary..."
bash "$(dirname "$0")/deployment-summary.sh" "$DEPLOYMENT_ID"
