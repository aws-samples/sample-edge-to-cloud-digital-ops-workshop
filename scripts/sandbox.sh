#!/usr/bin/env bash
# Usage: ./scripts/sandbox.sh [--force] [deployment-id]
#   deployment-id defaults to ws-slot00
#   --force bypasses the platform stack health check and always re-deploys it
#
# Checks whether WorkshopPlatformStack is deployed (or in progress).
# If not, deploys it first. Then starts the Amplify sandbox for this participant.

set -euo pipefail

FORCE=false
DEPLOYMENT_ID="ws-slot00"
for arg in "$@"; do
  if [[ "$arg" == "--force" ]]; then
    FORCE=true
  else
    DEPLOYMENT_ID="$arg"
  fi
done

PLATFORM_APP="npx tsx amplify/custom/platform-app.ts"

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

# ── Check whether the platform stack is fully deployed ──────────────────────
# Check by CloudFormation status rather than VPC presence — a rollback can
# leave VPCs behind while other resources (S3 bucket, MSK, etc.) are missing.
PLATFORM_STACK=""
if [[ "$FORCE" == "false" ]]; then
  STATUS=$(aws cloudformation describe-stacks \
    --stack-name "WorkshopPlatformStack" \
    --query "Stacks[0].StackStatus" \
    --output text 2>/dev/null || echo "DOES_NOT_EXIST")
  if [[ "$STATUS" == "CREATE_COMPLETE" || "$STATUS" == "UPDATE_COMPLETE" ]]; then
    PLATFORM_STACK="WorkshopPlatformStack"
    echo ">>> Platform stack is healthy ($STATUS). Skipping platform deploy."
  fi
else
  echo ">>> --force passed. Skipping health check and re-deploying platform stack."
fi

if [[ -z "$PLATFORM_STACK" ]]; then
  # The platform stack now owns the /workshop/platform/edge-nat-gateway-id SSM
  # parameter (see platform-stack.ts). On accounts first provisioned with an
  # older platform stack the parameter exists as an out-of-band orphan written
  # by this script; CFN would fail to *create* the managed parameter on top of
  # it. Delete the orphan first, but only if it isn't already a resource of the
  # deployed platform stack (a param that's already CFN-managed must be left for
  # the stack update to reconcile).
  ensure_no_orphan_nat_ssm "WorkshopPlatformStack"
  # Same reconciliation, for the workshop_telemetry Glue database/table now
  # owned by the platform stack (Firehose → Iceberg sink) — see #128.
  ensure_no_orphan_glue_telemetry_table "WorkshopPlatformStack"
  echo ">>> Deploying WorkshopPlatformStack..."
  npx cdk deploy \
    --app "$PLATFORM_APP" \
    --require-approval never \
    "WorkshopPlatformStack"
  echo ">>> Platform stack deployed."
fi

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

# ── Start Amplify sandbox for this participant ───────────────────────────────
export WORKSHOP_DEPLOYMENT_ID="$DEPLOYMENT_ID"
echo ">>> Starting Amplify sandbox --identifier $DEPLOYMENT_ID"
unset npm_config_prefix
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  . "$HOME/.nvm/nvm.sh"
  nvm install 22 --silent || true
  nvm use 22 --silent || echo ">>> nvm use 22 failed, falling back to system node ($(node -v 2>/dev/null || echo 'not found'))."
else
  echo ">>> nvm not found, using system node ($(node -v 2>/dev/null || echo 'not found'))."
fi
AMPX_STATUS=0
npx ampx sandbox --identifier "$DEPLOYMENT_ID" --once || AMPX_STATUS=$?
if [[ "$AMPX_STATUS" -ne 0 ]]; then
  echo "ERROR: ampx sandbox deploy failed (exit $AMPX_STATUS) — backend rolled back. Skipping device-registration wait, shadow seeding, and summary." >&2
  exit "$AMPX_STATUS"
fi

# ── Upload binary and simulator to S3 after CDK creates the bucket ──────────
echo ">>> Uploading IoT Device Client binary to s3://${S3_BUCKET}/bin/aws-iot-device-client…"
aws s3 cp "$LOCAL_BINARY_CACHE" "s3://${S3_BUCKET}/bin/aws-iot-device-client"

echo ">>> Uploading sensor simulator to s3://${S3_BUCKET}/simulator/sensor-sim.py…"
aws s3 cp simulator/sensor-sim.py "s3://${S3_BUCKET}/simulator/sensor-sim.py"

echo ">>> Uploading frac-op burst generator to s3://${S3_BUCKET}/simulator/frac-op-burst.py…"
aws s3 cp simulator/frac-op-burst.py "s3://${S3_BUCKET}/simulator/frac-op-burst.py"

echo ">>> Upload complete."

# ── Seed initial device-config and $package shadows ──────────────────────────
# EC2 instances self-register via fleet provisioning on first boot. Poll until
# all 3 things appear in the registry, then write the initial shadows so fleet
# indexing queries work before participants run any IoT Job.
echo ">>> Waiting for devices to self-register via fleet provisioning..."
IOT_ENDPOINT=$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text)
THING_NAMES=()
for attempt in $(seq 1 60); do
  THING_NAMES=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && THING_NAMES+=("$line")
  done < <(aws iot list-things-in-thing-group \
    --thing-group-name "${DEPLOYMENT_ID}-devices" \
    --query "things[]" --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true)
  echo "  ${#THING_NAMES[@]}/3 devices registered (attempt $attempt/60)..."
  [[ "${#THING_NAMES[@]}" -ge 3 ]] && break
  sleep 10
done

if [[ "${#THING_NAMES[@]}" -lt 3 ]]; then
  echo "WARNING: Only ${#THING_NAMES[@]} device(s) registered after 10 min — seeding shadows for those that exist."
fi

for THING in "${THING_NAMES[@]+"${THING_NAMES[@]}"}"; do
  echo "  Seeding shadows for $THING..."
  aws iot-data update-thing-shadow \
    --endpoint-url "https://$IOT_ENDPOINT" \
    --thing-name "$THING" \
    --shadow-name device-config \
    --cli-binary-format raw-in-base64-out \
    --payload '{"state":{"desired":{"telemetry_interval_ms":5000,"metrics":["cpu_pct","mem_used_pct","disk_used_pct"],"config_version":"1.0.0"},"reported":{"telemetry_interval_ms":5000,"metrics":["cpu_pct","mem_used_pct","disk_used_pct"],"config_version":"1.0.0"}}}' \
    /dev/null
  aws iot-data update-thing-shadow \
    --endpoint-url "https://$IOT_ENDPOINT" \
    --thing-name "$THING" \
    --shadow-name '$package' \
    --cli-binary-format raw-in-base64-out \
    --payload '{"state":{"reported":{"telemetry-agent":{"version":"1.0.0"}}}}' \
    /dev/null
done
echo ">>> Shadow seeding complete."

# ── Pre-warm the edge K3s cluster ────────────────────────────────────────────
# Launch the K3s bootstrap IoT Job now, during the facilitator pre-deploy, so the
# cluster is already up when attendees reach session 05 — instead of costing
# ~20 min of live session wall-clock. Idempotent: skips if the kubeconfig already
# exists in SSM. See scripts/launch-k3s.sh and workshop/05-edge-infra/block-2.
if [[ "${#THING_NAMES[@]}" -ge 3 ]]; then
  echo ">>> Pre-warming edge K3s cluster via IoT Job (runs during pre-deploy)…"
  bash "$(dirname "$0")/launch-k3s.sh" "$DEPLOYMENT_ID"
else
  echo ">>> Skipping K3s pre-warm — fewer than 3 devices registered."
fi

# ── Pre-warm the cloud analytics stack ──────────────────────────────────────
# RisingWave + TimescaleDB + Redpanda Connect + dashboard into the shared EKS
# cluster, during the facilitator pre-deploy — so it's already up when
# attendees reach session 04 instead of costing ~45 min of live session
# wall-clock. Idempotent: safe to re-run against an already-deployed slot.
# See scripts/deploy-cloud-analytics.sh and workshop/04-analytics/block-1.
echo ">>> Pre-warming cloud analytics stack via scripts/deploy-cloud-analytics.sh…"
bash "$(dirname "$0")/deploy-cloud-analytics.sh" --deployment-id "$DEPLOYMENT_ID"

# ── Write deployment summary ──────────────────────────────────────────────────
echo ">>> Generating deployment summary..."
bash "$(dirname "$0")/deployment-summary.sh" "$DEPLOYMENT_ID"
