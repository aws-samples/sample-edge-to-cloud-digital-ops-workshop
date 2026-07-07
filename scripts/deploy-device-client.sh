#!/usr/bin/env bash
# deploy-device-client.sh — upload a local IoT Device Client binary to S3, then
# use SSM to replace and restart it on all edge EC2 instances.
#
# Usage:
#   ./scripts/deploy-device-client.sh ws-slot00 [ws-slot01 ...]
#   ./scripts/deploy-device-client.sh --binary /path/to/binary ws-slot00
#
# Options:
#   --binary <path>   Local binary to upload
#                     (default: $HOME/.cache/workshop/aws-iot-device-client)
#
# Environment:
#   SSM_REGION        AWS region (default: us-east-1)
#   SSM_WAIT_SECS     Seconds to wait for SSM command completion (default: 60)

set -euo pipefail

REGION="${SSM_REGION:-us-east-1}"
SSM_WAIT_SECS="${SSM_WAIT_SECS:-60}"
LOCAL_BINARY="$HOME/.cache/workshop/aws-iot-device-client"
DEPLOYMENT_IDS=()

# ── Parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --binary)
      LOCAL_BINARY="$2"
      shift 2
      ;;
    *)
      DEPLOYMENT_IDS+=("$1")
      shift
      ;;
  esac
done

if [[ ${#DEPLOYMENT_IDS[@]} -eq 0 ]]; then
  echo "Usage: $0 [--binary <path>] <deployment-id> [deployment-id ...]" >&2
  exit 1
fi

if [[ ! -f "$LOCAL_BINARY" ]]; then
  echo "ERROR: binary not found at $LOCAL_BINARY" >&2
  echo "       Pass --binary <path> to specify a different location." >&2
  exit 1
fi

# ── Resolve S3 bucket ─────────────────────────────────────────────────────────
S3_BUCKET=$(aws cloudformation list-exports \
  --region "$REGION" \
  --query "Exports[?Name=='workshop-platform-bucket-name'].Value" \
  --output text)

if [[ -z "$S3_BUCKET" || "$S3_BUCKET" == "None" ]]; then
  echo "ERROR: could not resolve workshop-platform-bucket-name from CloudFormation exports." >&2
  echo "       Is the platform stack deployed in region $REGION?" >&2
  exit 1
fi

# ── Upload binary to S3 ───────────────────────────────────────────────────────
echo ">>> Uploading $(basename "$LOCAL_BINARY") to s3://${S3_BUCKET}/bin/aws-iot-device-client..."
aws s3 cp "$LOCAL_BINARY" "s3://${S3_BUCKET}/bin/aws-iot-device-client" \
  --region "$REGION"
echo ">>> Upload complete."

# ── Deploy to each deployment slot ───────────────────────────────────────────
OVERALL_FAILED=0

for DEPLOYMENT_ID in "${DEPLOYMENT_IDS[@]}"; do
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ">>> [$DEPLOYMENT_ID] Finding running edge instances..."

  INSTANCE_IDS=()
  while IFS= read -r inst; do
    [[ -n "$inst" ]] && INSTANCE_IDS+=("$inst")
  done < <(
    aws ec2 describe-instances \
      --region "$REGION" \
      --filters "Name=tag:WorkshopDeploymentId,Values=${DEPLOYMENT_ID}" \
                "Name=tag:Name,Values=workshop-*-edge-*" \
                "Name=instance-state-name,Values=running" \
      --query "Reservations[].Instances[].InstanceId" \
      --output text | tr '\t' '\n'
  )

  if [[ ${#INSTANCE_IDS[@]} -eq 0 ]]; then
    echo ">>> [$DEPLOYMENT_ID] WARNING: no running instances found — skipping."
    continue
  fi

  echo ">>> [$DEPLOYMENT_ID] Targeting: ${INSTANCE_IDS[*]}"

  # Build the SSM script with S3_BUCKET, REGION, and DEPLOYMENT_ID baked in.
  # Instance-local variables are escaped with \$ so they evaluate on the EC2.
  SSM_SCRIPT=$(cat <<SHELL
set -euo pipefail

REGION="${REGION}"
S3_BUCKET="${S3_BUCKET}"
DEPLOYMENT_ID="${DEPLOYMENT_ID}"

# ── Resolve instance ID ────────────────────────────────────────────────────
INSTANCE_ID=\$(ec2-metadata --instance-id | cut -d' ' -f2)
echo ">>> Instance: \$INSTANCE_ID  Deployment: \$DEPLOYMENT_ID"

# ── Replace binary ─────────────────────────────────────────────────────────
echo ">>> Downloading new aws-iot-device-client from S3..."
aws s3 cp "s3://\${S3_BUCKET}/bin/aws-iot-device-client" /usr/local/bin/aws-iot-device-client \\
  --region "\$REGION"
chmod +x /usr/local/bin/aws-iot-device-client
echo ">>> Binary replaced: \$(md5sum /usr/local/bin/aws-iot-device-client | cut -d' ' -f1)"

# ── Re-provision config if it's missing ───────────────────────────────────
CONF=/etc/aws-iot-device-client/aws-iot-device-client.conf
if [[ ! -f "\$CONF" ]]; then
  echo ">>> Config missing — running full provisioning setup..."

  mkdir -p /etc/aws-iot-device-client/certs
  chmod 700 /etc/aws-iot-device-client/certs

  # Claim certificates from Secrets Manager
  SECRET_JSON=\$(aws secretsmanager get-secret-value \\
    --region "\$REGION" \\
    --secret-id "/workshop/\${DEPLOYMENT_ID}/claim-cert" \\
    --query SecretString --output text)

  echo "\$SECRET_JSON" | python3 -c "
import json, sys
d = json.load(sys.stdin)
open('/etc/aws-iot-device-client/certs/claim.pem.crt', 'w').write(d['certificate'])
open('/etc/aws-iot-device-client/certs/claim-private.pem.key', 'w').write(d['privateKey'])
"
  chmod 644 /etc/aws-iot-device-client/certs/claim.pem.crt
  chmod 600 /etc/aws-iot-device-client/certs/claim-private.pem.key

  # Root CA
  curl -fsSo /etc/aws-iot-device-client/certs/AmazonRootCA1.pem \\
    https://www.amazontrust.com/repository/AmazonRootCA1.pem

  IOT_ENDPOINT=\$(aws iot describe-endpoint \\
    --region "\$REGION" \\
    --endpoint-type iot:Data-ATS \\
    --query endpointAddress --output text)

  mkdir -p /etc/aws-iot-device-client/jobs

  cat > "\$CONF" <<EOF
{
  "endpoint": "\$IOT_ENDPOINT",
  "cert": "/etc/aws-iot-device-client/certs/claim.pem.crt",
  "key": "/etc/aws-iot-device-client/certs/claim-private.pem.key",
  "root-ca": "/etc/aws-iot-device-client/certs/AmazonRootCA1.pem",
  "thing-name": "\$INSTANCE_ID",
  "fleet-provisioning": {
    "enabled": true,
    "template-name": "\${DEPLOYMENT_ID}-provisioning",
    "template-parameters": "{\\"ThingName\\":\\"\$INSTANCE_ID\\",\\"SerialNumber\\":\\"\$INSTANCE_ID\\"}"
  },
  "jobs": {
    "enabled": true,
    "handler-directory": "/etc/aws-iot-device-client/jobs"
  },
  "shadow": {
    "enabled": true
  },
  "tunneling": {
    "enabled": false
  },
  "logging": {
    "level": "INFO",
    "type": "FILE",
    "file": "/var/log/aws-iot-device-client.log"
  }
}
EOF
  chmod 640 "\$CONF"

  # Job handler
  cat > /etc/aws-iot-device-client/jobs/run-script.sh <<'HANDLER'
#!/bin/bash
set -euo pipefail
SCRIPT_URI="\${2:-}"
if [[ -z "\$SCRIPT_URI" ]]; then
  echo "ERROR: no scriptUri provided as arg" >&2
  exit 1
fi
aws s3 cp "\$SCRIPT_URI" /tmp/job-script.sh
chmod +x /tmp/job-script.sh
/tmp/job-script.sh
HANDLER
  chmod +x /etc/aws-iot-device-client/jobs/run-script.sh

  mkdir -p /root/.aws-iot-device-client
  ln -sfn /etc/aws-iot-device-client/jobs /root/.aws-iot-device-client/jobs

  # Systemd service
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
  echo ">>> Full provisioning complete."
fi

# ── Ensure service is enabled and (re)start ───────────────────────────────
systemctl enable aws-iot-device-client 2>/dev/null || true
systemctl restart aws-iot-device-client
sleep 5

SERVICE_STATE=\$(systemctl is-active aws-iot-device-client 2>&1 || true)
echo ">>> Service state: \$SERVICE_STATE"
journalctl -u aws-iot-device-client -n 20 --no-pager 2>/dev/null || true
SHELL
)

  PARAMS_FILE=$(mktemp /tmp/ssm-params-XXXXXX.json)
  # shellcheck disable=SC2064
  trap "rm -f $PARAMS_FILE" EXIT
  python3 -c "
import json, sys
script = sys.stdin.read()
print(json.dumps({'commands': [script]}))
" <<< "$SSM_SCRIPT" > "$PARAMS_FILE"

  CMD_ID=$(aws ssm send-command \
    --region "$REGION" \
    --instance-ids "${INSTANCE_IDS[@]}" \
    --document-name "AWS-RunShellScript" \
    --parameters "file://$PARAMS_FILE" \
    --query "Command.CommandId" \
    --output text)

  echo ">>> [$DEPLOYMENT_ID] Command ID: $CMD_ID — waiting ${SSM_WAIT_SECS}s..."
  sleep "$SSM_WAIT_SECS"

  SLOT_FAILED=0
  for INST in "${INSTANCE_IDS[@]}"; do
    RESULT=$(aws ssm get-command-invocation \
      --region "$REGION" \
      --command-id "$CMD_ID" \
      --instance-id "$INST" \
      --query "{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}" \
      --output json 2>&1)

    STATUS=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['Status'])" 2>/dev/null || echo "UNKNOWN")
    STDOUT=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['Stdout'].rstrip())" 2>/dev/null || echo "")
    STDERR=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['Stderr'].rstrip())" 2>/dev/null || echo "")

    if [[ "$STATUS" == "Success" ]]; then
      ICON="✓"
    else
      ICON="✗"
      SLOT_FAILED=$((SLOT_FAILED + 1))
      OVERALL_FAILED=$((OVERALL_FAILED + 1))
    fi

    echo ""
    echo "━━━ $ICON  $INST  [$STATUS] ━━━"
    [[ -n "$STDOUT" ]] && echo "$STDOUT"
    [[ -n "$STDERR" ]] && echo "--- stderr ---" && echo "$STDERR"
  done

  echo ""
  if [[ $SLOT_FAILED -eq 0 ]]; then
    echo ">>> [$DEPLOYMENT_ID] All ${#INSTANCE_IDS[@]} instance(s) updated successfully."
  else
    echo ">>> [$DEPLOYMENT_ID] $SLOT_FAILED of ${#INSTANCE_IDS[@]} instance(s) failed."
  fi
done

[[ $OVERALL_FAILED -gt 0 ]] && exit 1 || exit 0
