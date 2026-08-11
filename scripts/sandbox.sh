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

# ── Build IoT Device Client binary and stage to S3 ──────────────────────────
# Uses the official GHCR build image so EC2 user data only needs a fast S3 download.
# The binary is cached locally after the first build; subsequent runs skip the build step.
# Cache key suffix bumped for #166 (MQTT keep-alive patch) so a pre-existing
# cached binary from before this fix is never reused silently.
LOCAL_BINARY_CACHE="$HOME/.cache/workshop/aws-iot-device-client-keepalive-v1"
# Resolve the bucket name from the CloudFormation export — avoids hardcoding.
S3_BUCKET=$(aws cloudformation list-exports \
  --query "Exports[?Name=='workshop-platform-bucket-name'].Value" \
  --output text)

if [[ ! -f "$LOCAL_BINARY_CACHE" ]]; then
  echo ">>> Building AWS IoT Device Client using ECR Public amazonlinux image (one-time, ~8 min)…"
  DC_SRC=$(mktemp -d)
  git clone --depth 1 --branch v1.10.1 \
    https://github.com/awslabs/aws-iot-device-client "$DC_SRC"
  # #166: v1.10.1 never opts its MQTT socket into SO_KEEPALIVE (no call to
  # WithTcpKeepAlive() anywhere in SharedCrtResourceManager.cpp, confirmed by
  # reading the pinned tag's source), and Connect() is called with
  # keepAliveTimeSecs=0, which falls back to the aws-c-mqtt SDK's hardcoded
  # 1200s default (source/client.c: s_default_keep_alive_sec). Kernel TCP
  # keepalive (the sysctl tuning in participant-stack.ts) only fires on
  # sockets that have opted in via SO_KEEPALIVE, so it is inert against this
  # socket without this patch. There is also no config-schema field to
  # express this without a source change (PlainConfig has no keep-alive key).
  # Patch: opt the MQTT socket into TCP keepalive so the OS-level sysctl
  # values actually apply to it, and lower the MQTT PINGREQ interval itself
  # below the 350s NAT idle timeout so protocol-level traffic keeps the flow
  # warm even if TCP keepalive is ever disabled at the OS layer.
  KEEPALIVE_PATCH_MARKER='clientConfigBuilder.WithSdkVersion(DEVICE_CLIENT_VERSION);'
  CONNECT_PATCH_MARKER='connection->Connect(config.thingName->c_str(), false)'
  grep -qF "$KEEPALIVE_PATCH_MARKER" "$DC_SRC/source/SharedCrtResourceManager.cpp" || {
    echo "ERROR: #166 keep-alive patch anchor not found in SharedCrtResourceManager.cpp — upstream source has changed, update the patch." >&2
    exit 1
  }
  grep -qF "$CONNECT_PATCH_MARKER" "$DC_SRC/source/SharedCrtResourceManager.cpp" || {
    echo "ERROR: #166 keep-alive patch Connect() anchor not found in SharedCrtResourceManager.cpp — upstream source has changed, update the patch." >&2
    exit 1
  }
  # Use perl (not `sed -i`) for portability: BSD/macOS sed requires an explicit
  # backup-suffix arg after -i and does not expand `\n` in the replacement, so a
  # GNU-style `sed -i "s|...|...\n...|"` fails on a Mac host with
  # "invalid command code". perl -i -pe behaves identically on macOS and Linux.
  # \Q..\E matches the anchors as literal strings (the ()/./-> chars are not
  # treated as regex); the markers are passed via env to avoid quoting issues.
  KP="$KEEPALIVE_PATCH_MARKER" perl -i -pe \
    's/\Q$ENV{KP}\E/$ENV{KP}\n    clientConfigBuilder.WithTcpKeepAlive();/' \
    "$DC_SRC/source/SharedCrtResourceManager.cpp"
  CP="$CONNECT_PATCH_MARKER" perl -i -pe \
    's/\Q$ENV{CP}\E/connection->Connect(config.thingName->c_str(), false, 180, 10000)/' \
    "$DC_SRC/source/SharedCrtResourceManager.cpp"
  # Drop the unit-test subdirectory from the build. v1.10.1's top-level
  # CMakeLists.txt calls `add_subdirectory(test)` unconditionally, and
  # test/CMakeLists.txt then requires gtest — either via a configure-time
  # `git clone` of googletest (BUILD_TEST_DEPS=ON, which fails intermittently
  # with "Could not resolve host", especially under amd64 emulation) or via
  # `find_package(GTest REQUIRED)` (BUILD_TEST_DEPS=OFF, which errors when gtest
  # isn't installed). We only ship the production binary, so remove the test
  # dir entirely — no gtest needed by any path, and one less flaky network step.
  TEST_SUBDIR_MARKER='add_subdirectory(test)'
  grep -qF "$TEST_SUBDIR_MARKER" "$DC_SRC/CMakeLists.txt" || {
    echo "ERROR: 'add_subdirectory(test)' not found in CMakeLists.txt — upstream layout changed, update the patch." >&2
    exit 1
  }
  TS="$TEST_SUBDIR_MARKER" perl -i -pe \
    's/^(\s*)(\Q$ENV{TS}\E)/$1# $2  # removed: production build needs no gtest/' \
    "$DC_SRC/CMakeLists.txt"
  # Use public.ecr.aws/amazonlinux/amazonlinux instead of the GHCR build image.
  # Run cmake install + build steps directly inside the container.
  # AL2023 (OpenSSL 3.x) is required — IoT Device Client v1.10.1 needs OpenSSL >= 1.1,
  # but AL2 ships 1.0.2k. Explicit OPENSSL_*_LIBRARY paths work around cmake's
  # FindOpenSSL module failing to locate libcrypto/libssl on this image.
  # Pin --platform linux/amd64: the edge EC2 instances are x86_64, but on an
  # Apple Silicon host Docker would otherwise build a linux/arm64 binary that
  # dies on the device with "Exec format error" (status=203/EXEC). Emulated
  # amd64 build is slower but produces the correct arch. (CI's ubuntu-latest is
  # already amd64, so this is a no-op there.)
  docker run --rm --platform linux/amd64 \
    -v "$DC_SRC:/root/aws-iot-device-client" \
    public.ecr.aws/amazonlinux/amazonlinux:2023 \
    bash -c "
      dnf install -y cmake gcc gcc-c++ openssl-devel \
        libcurl-devel git make zip unzip tar && \
      cd /root/aws-iot-device-client && \
      cmake -B build -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_TEST_DEPS=OFF \
        -DEXCLUDE_JOBS=OFF -DEXCLUDE_NAMED_SHADOW=OFF \
        -DEXCLUDE_TUNNELING=ON -DEXCLUDE_DEVICE_DEFENDER=ON \
        -DEXCLUDE_FLEET_PROVISIONING=OFF \
        -DOPENSSL_CRYPTO_LIBRARY=/usr/lib64/libcrypto.so \
        -DOPENSSL_SSL_LIBRARY=/usr/lib64/libssl.so && \
      cmake --build build --target aws-iot-device-client -j\$(nproc) && \
      chmod -R a+rwX /root/aws-iot-device-client 2>/dev/null || true
    "
  mkdir -p "$(dirname "$LOCAL_BINARY_CACHE")"
  cp "$DC_SRC/build/aws-iot-device-client" "$LOCAL_BINARY_CACHE"
  rm -rf "$DC_SRC"
  echo ">>> Binary cached at $LOCAL_BINARY_CACHE"
else
  echo ">>> Using cached IoT Device Client binary."
fi

# ── Upload binary and simulator to the shared S3 bucket ──────────────────────
# The bucket is a platform-stack resource, created by the deploy above.
echo ">>> Uploading IoT Device Client binary to s3://${S3_BUCKET}/bin/aws-iot-device-client…"
aws s3 cp "$LOCAL_BINARY_CACHE" "s3://${S3_BUCKET}/bin/aws-iot-device-client"

echo ">>> Uploading sensor simulator to s3://${S3_BUCKET}/simulator/sensor-sim.py…"
aws s3 cp simulator/sensor-sim.py "s3://${S3_BUCKET}/simulator/sensor-sim.py"

echo ">>> Uploading frac-op burst generator to s3://${S3_BUCKET}/simulator/frac-op-burst.py…"
aws s3 cp simulator/frac-op-burst.py "s3://${S3_BUCKET}/simulator/frac-op-burst.py"

echo ">>> Upload complete."

# ── Per-slot post-deploy tail ────────────────────────────────────────────────
# Device self-registration wait, shadow seeding, K3s + cloud-analytics pre-warm.
# Factored into scripts/post-deploy-slot.sh so sandbox.sh, sandbox-all.sh and the
# CI orchestrator all run the identical steps. Idempotent.
bash "$(dirname "$0")/post-deploy-slot.sh" "$DEPLOYMENT_ID"

# ── Write deployment summary ──────────────────────────────────────────────────
echo ">>> Generating deployment summary..."
bash "$(dirname "$0")/deployment-summary.sh" "$DEPLOYMENT_ID"
