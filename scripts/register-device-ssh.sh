#!/usr/bin/env bash
# register-device-ssh.sh — register a new device (e.g. a Raspberry Pi) with AWS
# IoT Core over SSH, using fleet provisioning by claim.
#
# The script runs on YOUR machine (with your AWS credentials). It:
#   1. Fetches the shared claim certificate from Secrets Manager and the IoT
#      data endpoint — locally, using your AWS credentials.
#   2. Connects to the device over SSH and builds the aws-iot-device-client
#      natively on the device (correct arch/OS/OpenSSL by construction).
#   3. Copies the claim certificate to the device and writes the device-client
#      config with a fleet-provisioning block.
#   4. Installs and starts the systemd service so the device self-registers as a
#      new Thing (a unique per-device certificate is minted during provisioning).
#   5. Verifies the Thing appears in the IoT registry for the deployment.
#
# The device never holds AWS credentials — its only secret is the claim cert,
# which is scoped to the provisioning topics only.
#
# Usage:
#   ./scripts/register-device-ssh.sh --ssh pi@raspberrypi.local --deployment-id ws-slot00
#   ./scripts/register-device-ssh.sh --ssh pi@10.0.0.42 -i ~/.ssh/id_rsa \
#       --deployment-id ws-slot00 --thing-name my-pi-01
#
# Options:
#   --ssh <user@host>     SSH target for the device (required)
#   --deployment-id <id>  Workshop deployment/slot, e.g. ws-slot00 (required)
#   --thing-name <name>   Thing name to register (default: device-<remote hostname>)
#   -i, --identity <key>  SSH private key file (passed to ssh/scp -i)
#   --ssh-opt <opt>       Extra option passed to ssh/scp (repeatable),
#                         e.g. --ssh-opt "-o StrictHostKeyChecking=no"
#   --skip-build          Reuse an aws-iot-device-client already on the device
#   -h, --help            Show this help
#
# Environment:
#   AWS_REGION            AWS region (default: us-east-1)
#   REGISTER_WAIT_SECS    Seconds to wait for the Thing to appear (default: 120)

set -euo pipefail

# --8<-- [start:usage]
REGION="${AWS_REGION:-us-east-1}"
REGISTER_WAIT_SECS="${REGISTER_WAIT_SECS:-120}"
DEVICE_CLIENT_VERSION="v1.10.1"

SSH_TARGET=""
DEPLOYMENT_ID=""
THING_NAME=""
SKIP_BUILD=false
SSH_OPTS=()

usage() { sed -n '2,40p' "$0"; exit "${1:-0}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ssh)           SSH_TARGET="$2"; shift 2 ;;
    --deployment-id) DEPLOYMENT_ID="$2"; shift 2 ;;
    --thing-name)    THING_NAME="$2"; shift 2 ;;
    -i|--identity)   SSH_OPTS+=("-i" "$2"); shift 2 ;;
    --ssh-opt)       SSH_OPTS+=("$2"); shift 2 ;;
    --skip-build)    SKIP_BUILD=true; shift ;;
    -h|--help)       usage 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage 1 ;;
  esac
done

if [[ -z "$SSH_TARGET" || -z "$DEPLOYMENT_ID" ]]; then
  echo "ERROR: --ssh and --deployment-id are required." >&2
  usage 1
fi
# --8<-- [end:usage]

# Helpers that run a command / copy a file on the device over SSH.
# Expand SSH_OPTS safely even when empty — under `set -u`, bash < 4.4 (macOS
# ships 3.2) treats "${SSH_OPTS[@]}" on an empty array as an unbound variable.
ssh_run() { ssh "${SSH_OPTS[@]+"${SSH_OPTS[@]}"}" "$SSH_TARGET" "$@"; }
scp_to()  { scp "${SSH_OPTS[@]+"${SSH_OPTS[@]}"}" "$1" "$SSH_TARGET:$2"; }

# ── Resolve claim cert + IoT endpoint locally (your AWS credentials) ──────────
# --8<-- [start:fetch-claim]
echo ">>> Fetching claim certificate for $DEPLOYMENT_ID from Secrets Manager..."
SECRET_JSON=$(aws secretsmanager get-secret-value \
  --region "$REGION" \
  --secret-id "/workshop/${DEPLOYMENT_ID}/claim-cert" \
  --query SecretString --output text)

IOT_ENDPOINT=$(aws iot describe-endpoint \
  --region "$REGION" \
  --endpoint-type iot:Data-ATS \
  --query endpointAddress --output text)
echo ">>> IoT endpoint: $IOT_ENDPOINT"
# --8<-- [end:fetch-claim]

# Default the Thing name to the device's own hostname if not supplied.
if [[ -z "$THING_NAME" ]]; then
  REMOTE_HOST=$(ssh_run "hostname" | tr -d '[:space:]')
  THING_NAME="device-${REMOTE_HOST}"
fi
echo ">>> Registering Thing: $THING_NAME"

# ── Build the device client on the device (native arch/OS) ────────────────────
# --8<-- [start:build-device-client]
# Build on the device itself so the binary matches its architecture, libc, and
# OpenSSL version automatically. The default apt packages target Raspberry Pi OS
# / Debian / Ubuntu (arm64). For other OS stacks, change ONLY the install line:
#   Amazon Linux 2023 / RHEL / Fedora:
#     sudo dnf install -y cmake gcc gcc-c++ openssl-devel libcurl-devel git make
#   Alpine:
#     sudo apk add cmake g++ openssl-dev curl-dev git make
# The rule: build on the same OS/arch family the binary will run on. IoT Device
# Client v1.10.1 needs OpenSSL >= 1.1 (Raspberry Pi OS Bookworm ships 3.x).
if [[ "$SKIP_BUILD" == false ]]; then
  echo ">>> Building aws-iot-device-client $DEVICE_CLIENT_VERSION on the device (~8 min)..."
  ssh_run "bash -s" <<BUILD
set -euo pipefail
sudo apt-get update -qq
sudo apt-get install -y cmake gcc g++ libssl-dev libcurl4-openssl-dev git make

SRC=\$(mktemp -d)
git clone --depth 1 --branch ${DEVICE_CLIENT_VERSION} \
  https://github.com/awslabs/aws-iot-device-client "\$SRC"
cd "\$SRC"
cmake -B build -DCMAKE_BUILD_TYPE=Release \
  -DEXCLUDE_JOBS=OFF -DEXCLUDE_NAMED_SHADOW=OFF \
  -DEXCLUDE_TUNNELING=ON -DEXCLUDE_DEVICE_DEFENDER=ON \
  -DEXCLUDE_FLEET_PROVISIONING=OFF
cmake --build build --target aws-iot-device-client -j"\$(nproc)"
sudo install -m 0755 build/aws-iot-device-client /usr/local/bin/aws-iot-device-client
rm -rf "\$SRC"
echo ">>> Built: \$(/usr/local/bin/aws-iot-device-client --version 2>&1 | head -1)"
BUILD
else
  echo ">>> --skip-build: reusing aws-iot-device-client already on the device."
fi
# --8<-- [end:build-device-client]

# ── Push claim cert + write config on the device ──────────────────────────────
# --8<-- [start:provision]
echo ">>> Writing claim certificate and device-client config on the device..."

# Split the claim secret into cert + key locally, then copy each to the device.
CERT_TMP=$(mktemp); KEY_TMP=$(mktemp)
trap 'rm -f "$CERT_TMP" "$KEY_TMP"' EXIT
python3 - "$SECRET_JSON" <<'PY' "$CERT_TMP" "$KEY_TMP"
import json, sys
secret = json.loads(sys.argv[1])
open(sys.argv[2], "w").write(secret["certificate"])
open(sys.argv[3], "w").write(secret["privateKey"])
PY
scp_to "$CERT_TMP" "/tmp/claim.pem.crt"
scp_to "$KEY_TMP"  "/tmp/claim-private.pem.key"

# Everything below runs on the device: install certs, root CA, config, service.
ssh_run "sudo THING_NAME='$THING_NAME' DEPLOYMENT_ID='$DEPLOYMENT_ID' \
  IOT_ENDPOINT='$IOT_ENDPOINT' bash -s" <<'PROVISION'
set -euo pipefail

# Clear any state left by a previous fleet-provisioning run. After a successful
# provision the device client writes a runtime config (~/.aws-iot-device-client/
# with "completed-fp": true) and the minted per-device certificate; on the next
# start it reuses that identity and never re-runs provisioning with the claim
# cert. If that old per-device cert has since been revoked/deleted (e.g. the slot
# was redeployed), the client just loops on AWS_ERROR_MQTT_UNEXPECTED_HANGUP and
# the device silently fails to re-register. Wiping the runtime state forces a
# clean fleet-provisioning run against the claim cert. The service runs as root,
# so the runtime dir lives under /root.
systemctl stop aws-iot-device-client 2>/dev/null || true
rm -rf /root/.aws-iot-device-client

install -d -m 700 /etc/aws-iot-device-client/certs
install -m 644 /tmp/claim.pem.crt        /etc/aws-iot-device-client/certs/claim.pem.crt
install -m 600 /tmp/claim-private.pem.key /etc/aws-iot-device-client/certs/claim-private.pem.key
rm -f /tmp/claim.pem.crt /tmp/claim-private.pem.key

curl -fsSo /etc/aws-iot-device-client/certs/AmazonRootCA1.pem \
  https://www.amazontrust.com/repository/AmazonRootCA1.pem

CONF=/etc/aws-iot-device-client/aws-iot-device-client.conf
cat > "$CONF" <<EOF
{
  "endpoint": "$IOT_ENDPOINT",
  "cert": "/etc/aws-iot-device-client/certs/claim.pem.crt",
  "key": "/etc/aws-iot-device-client/certs/claim-private.pem.key",
  "root-ca": "/etc/aws-iot-device-client/certs/AmazonRootCA1.pem",
  "thing-name": "$THING_NAME",
  "fleet-provisioning": {
    "enabled": true,
    "template-name": "${DEPLOYMENT_ID}-provisioning",
    "template-parameters": "{\"ThingName\":\"$THING_NAME\",\"SerialNumber\":\"$THING_NAME\"}"
  },
  "shadow": { "enabled": true },
  "tunneling": { "enabled": false },
  "logging": {
    "level": "INFO",
    "type": "FILE",
    "file": "/var/log/aws-iot-device-client.log"
  }
}
EOF
chmod 640 "$CONF"

cat > /etc/systemd/system/aws-iot-device-client.service <<EOF
[Unit]
Description=AWS IoT Device Client
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/aws-iot-device-client --config-file /etc/aws-iot-device-client/aws-iot-device-client.conf
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable aws-iot-device-client
systemctl restart aws-iot-device-client
sleep 5
echo ">>> Service state: $(systemctl is-active aws-iot-device-client)"
PROVISION
# --8<-- [end:provision]

# ── Verify the Thing registered ───────────────────────────────────────────────
# --8<-- [start:verify]
echo ">>> Waiting for '$THING_NAME' to appear in the IoT registry (up to ${REGISTER_WAIT_SECS}s)..."
DEADLINE=$((SECONDS + REGISTER_WAIT_SECS))
while (( SECONDS < DEADLINE )); do
  if aws iot describe-thing --region "$REGION" --thing-name "$THING_NAME" >/dev/null 2>&1; then
    echo ">>> ✓ Registered: $THING_NAME is now a Thing in $DEPLOYMENT_ID."
    exit 0
  fi
  sleep 5
done

echo ">>> ✗ '$THING_NAME' did not register within ${REGISTER_WAIT_SECS}s." >&2
echo "    Check the device log: ssh $SSH_TARGET 'sudo tail -50 /var/log/aws-iot-device-client.log'" >&2
exit 1
# --8<-- [end:verify]
