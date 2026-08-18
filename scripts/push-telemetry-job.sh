#!/usr/bin/env bash
# Re-push the current job-scripts/<telemetry-script> handler to every registered
# device in a slot's Thing Group via an IoT Job.
#
# #248 gap A: UserData installs the persistent-MQTT publisher (#244) only on a
# device's FIRST boot. A branch/code redeploy does not re-run UserData on
# already-registered devices, and — even on a brand-new device — nothing
# re-uploads the telemetry handler to its per-slot S3 path, so an IoT Job
# created in an earlier session (or a stale S3 object from before #244) can
# leave the fleet on the old per-message `aws iot-data publish` path with no
# automated way back to the coprocess/mqtt-publisher.py form. Running this
# after every deploy makes the current job-scripts content authoritative for
# the whole fleet, not just devices that happen to receive a fresh UserData run.
#
# #257: the pre-Session-2 baseline is telemetry-v1.sh (integer-precision
# metrics) — the 3-decimal-precision telemetry-v2.sh is the Session 2 IoT Job
# exercise payoff and must not appear before a participant runs it. Defaulting
# to v1 here keeps every-deploy re-push (#248) from spoiling that before/after
# demo. The version arg stays so this script still works as the manual/
# maintenance path for re-pushing v2 (or any future version) to a live slot.
#
# Usage: scripts/push-telemetry-job.sh <deployment-id> [telemetry-script]
#   telemetry-script defaults to telemetry-v1.sh; pass e.g. telemetry-v2.sh to
#   re-push the Session 2 handler to an already-provisioned slot.
#
# Idempotent: creates a new (uniquely-named) SNAPSHOT job every run targeting
# the slot's current Thing Group members; safe to re-run against a live slot.
# Does not block on job completion — callers that need to wait (e.g. the
# device-hop latency check) should poll `aws iot describe-job`.
set -euo pipefail

DEPLOYMENT_ID="${1:-}"
if [[ -z "$DEPLOYMENT_ID" ]]; then
  echo "Usage: $0 <deployment-id> [telemetry-script]   (e.g. ws-slot00 telemetry-v2.sh)" >&2
  exit 2
fi

TELEMETRY_SCRIPT="${2:-telemetry-v1.sh}"
TELEMETRY_VERSION="${TELEMETRY_SCRIPT%.sh}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
THING_GROUP="${DEPLOYMENT_ID}-devices"

# ── Resolve the shared platform bucket from the CFN export ───────────────────
S3_BUCKET=$(aws cloudformation list-exports \
  --query "Exports[?Name=='workshop-platform-bucket-name'].Value" \
  --output text)
if [[ -z "$S3_BUCKET" || "$S3_BUCKET" == "None" ]]; then
  echo "ERROR: could not resolve workshop-platform-bucket-name CFN export." >&2
  exit 1
fi

# ── Bail out early if there is nothing to target ──────────────────────────────
THING_COUNT=$(aws iot list-things-in-thing-group \
  --thing-group-name "$THING_GROUP" \
  --query "things[]" --output text 2>/dev/null | tr '\t' '\n' | grep -c . || true)
if [[ "$THING_COUNT" -eq 0 ]]; then
  echo ">>> [$DEPLOYMENT_ID] No devices registered in $THING_GROUP yet — skipping telemetry job push."
  exit 0
fi

# ── Stage the current job handler + job document to S3 ───────────────────────
echo ">>> Uploading current ${TELEMETRY_SCRIPT} to s3://${S3_BUCKET}/job-scripts/${DEPLOYMENT_ID}/${TELEMETRY_SCRIPT}"
aws s3 cp "$REPO_ROOT/job-scripts/${TELEMETRY_SCRIPT}" \
  "s3://${S3_BUCKET}/job-scripts/${DEPLOYMENT_ID}/${TELEMETRY_SCRIPT}"

JOB_DOC=$(mktemp)
trap 'rm -f "$JOB_DOC"' EXIT
cat > "$JOB_DOC" <<EOF
{
  "version": "1.0",
  "steps": [
    {
      "action": {
        "name": "apply-${TELEMETRY_VERSION}",
        "type": "runHandler",
        "input": {
          "handler": "run-script.sh",
          "args": ["s3://${S3_BUCKET}/job-scripts/${DEPLOYMENT_ID}/${TELEMETRY_SCRIPT}"]
        },
        "runAsUser": ""
      }
    }
  ]
}
EOF

echo ">>> Uploading job document to s3://${S3_BUCKET}/${DEPLOYMENT_ID}/job-docs/${TELEMETRY_VERSION}-job-doc.json"
aws s3 cp "$JOB_DOC" \
  "s3://${S3_BUCKET}/${DEPLOYMENT_ID}/job-docs/${TELEMETRY_VERSION}-job-doc.json"

# ── Create the IoT Job targeting the slot's device Thing Group ───────────────
TARGET_ARN=$(aws iot describe-thing-group \
  --thing-group-name "$THING_GROUP" \
  --query thingGroupArn --output text)

JOB_ID="${DEPLOYMENT_ID}-${TELEMETRY_VERSION}-$(date +%s)"
echo ">>> Creating IoT Job $JOB_ID (target $THING_GROUP, $THING_COUNT device(s))…"
aws iot create-job \
  --job-id "$JOB_ID" \
  --targets "$TARGET_ARN" \
  --document-source "s3://${S3_BUCKET}/${DEPLOYMENT_ID}/job-docs/${TELEMETRY_VERSION}-job-doc.json" \
  --timeout-config '{"inProgressTimeoutInMinutes":10}' \
  --output json >/dev/null

# ── Nudge the device clients to pick the job up immediately (#146) ───────────
# Same notify-next race as launch-k3s.sh: a device that's gone idle waiting for
# the next job does not reliably act on the MQTT notify for a job created
# afterwards. Restart forces an immediate re-scan. Best-effort — a restart
# failure must not fail this script; the job will still run on the device's
# own poll cycle, just later.
echo ">>> Nudging aws-iot-device-client on edge devices to pick up $JOB_ID (notify-next race workaround)…"
DEVICE_INSTANCE_IDS=$(aws ec2 describe-instances \
  --filters \
    "Name=tag:WorkshopDeploymentId,Values=${DEPLOYMENT_ID}" \
    "Name=tag:Name,Values=*edge-?" \
    "Name=instance-state-name,Values=running" \
  --query "Reservations[].Instances[].InstanceId" \
  --output text 2>/dev/null || true)
if [[ -n "${DEVICE_INSTANCE_IDS// }" ]]; then
  # Intentional word-splitting of the id list.
  # shellcheck disable=SC2086
  if aws ssm send-command \
      --instance-ids $DEVICE_INSTANCE_IDS \
      --document-name "AWS-RunShellScript" \
      --comment "Restart aws-iot-device-client for ${TELEMETRY_VERSION} job pickup (#248)" \
      --parameters 'commands=["systemctl restart aws-iot-device-client"]' \
      --query "Command.CommandId" --output text >/dev/null 2>&1; then
    echo ">>> Sent device-client restart to: $DEVICE_INSTANCE_IDS"
  else
    echo ">>> WARN: could not send device-client restart (continuing; job may still run)." >&2
  fi
else
  echo ">>> WARN: no running edge instances found to nudge (continuing)." >&2
fi

echo ">>> [$DEPLOYMENT_ID] Telemetry job $JOB_ID created. Check status with:"
echo "      aws iot describe-job --job-id $JOB_ID --query 'job.status'"
