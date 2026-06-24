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
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
S3_BUCKET="workshop-platform-${ACCOUNT_ID}"

if [[ ! -f "$LOCAL_BINARY_CACHE" ]]; then
  echo ">>> Building AWS IoT Device Client using ECR Public amazonlinux image (one-time, ~8 min)…"
  DC_SRC=$(mktemp -d)
  git clone --depth 1 --branch v1.10.1 \
    https://github.com/awslabs/aws-iot-device-client "$DC_SRC"
  # Use public.ecr.aws/amazonlinux/amazonlinux instead of the GHCR build image.
  # Run cmake install + build steps directly inside the container.
  docker run --rm \
    -v "$DC_SRC:/root/aws-iot-device-client" \
    public.ecr.aws/amazonlinux/amazonlinux:2 \
    bash -c "
      yum install -y cmake3 gcc gcc-c++ openssl-devel \
        libcurl-devel git make zip unzip tar && \
      ln -sf /usr/bin/cmake3 /usr/local/bin/cmake && \
      cd /root/aws-iot-device-client && \
      cmake -B build -DCMAKE_BUILD_TYPE=Release \
        -DEXCLUDE_JOBS=ON -DEXCLUDE_NAMED_SHADOW=ON \
        -DEXCLUDE_TUNNELING=ON -DEXCLUDE_DEVICE_DEFENDER=ON \
        -DEXCLUDE_FLEET_PROVISIONING=OFF && \
      cmake --build build --target aws-iot-device-client -j\$(nproc)
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
. "$HOME/.nvm/nvm.sh"
nvm use 22 --silent
npx ampx sandbox --identifier "$DEPLOYMENT_ID" --once

# ── Upload binary and simulator to S3 after CDK creates the bucket ──────────
echo ">>> Uploading IoT Device Client binary to s3://${S3_BUCKET}/bin/aws-iot-device-client…"
aws s3 cp "$LOCAL_BINARY_CACHE" "s3://${S3_BUCKET}/bin/aws-iot-device-client"

echo ">>> Uploading sensor simulator to s3://${S3_BUCKET}/simulator/sensor-sim.py…"
aws s3 cp simulator/sensor-sim.py "s3://${S3_BUCKET}/simulator/sensor-sim.py"

echo ">>> Upload complete."

# ── Seed initial device-config and $package shadows ──────────────────────────
# EC2 instances self-register via fleet provisioning on first boot. Poll until
# all 3 things appear in the registry, then write the initial shadows so fleet
# indexing queries work before participants run any IoT Job.
echo ">>> Waiting for devices to self-register via fleet provisioning..."
IOT_ENDPOINT=$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text)
THING_NAMES=()
for attempt in $(seq 1 60); do
  mapfile -t THING_NAMES < <(aws iot list-things-in-thing-group \
    --thing-group-name "${DEPLOYMENT_ID}-devices" \
    --query "things[]" --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true)
  echo "  ${#THING_NAMES[@]}/3 devices registered (attempt $attempt/60)..."
  [[ "${#THING_NAMES[@]}" -ge 3 ]] && break
  sleep 10
done

if [[ "${#THING_NAMES[@]}" -lt 3 ]]; then
  echo "WARNING: Only ${#THING_NAMES[@]} device(s) registered after 10 min — seeding shadows for those that exist."
fi

for THING in "${THING_NAMES[@]}"; do
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

# ── Write deployment summary ──────────────────────────────────────────────────
echo ">>> Generating deployment summary..."
bash "$(dirname "$0")/deployment-summary.sh" "$DEPLOYMENT_ID"
