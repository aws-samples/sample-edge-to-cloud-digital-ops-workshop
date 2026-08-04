#!/usr/bin/env bash
# Launch the edge K3s cluster for a slot via IoT Job.
#
# This is the automated form of workshop/05-edge-infra/block-2-k3s-launch.md,
# extracted so scripts/sandbox.sh can PRE-WARM the cluster during the (already
# 20-40 min) facilitator pre-deploy — before attendees arrive — instead of
# costing 20 min of live session-05 wall-clock. It can also be run standalone
# to (re)launch K3s on an existing slot:
#
#     scripts/launch-k3s.sh ws-slot00
#
# Idempotent: if the kubeconfig already exists in SSM (cluster already up) it
# exits 0 immediately. The underlying job-scripts/deploy-k3s.sh is itself a safe
# no-op re-run (k3s installer detects an existing install), so a re-launch after
# a partial failure is harmless.
#
# Exit 0 = kubeconfig present in SSM (cluster ready). Non-zero = failed/timed out.
set -euo pipefail

DEPLOYMENT_ID="${1:-}"
if [[ -z "$DEPLOYMENT_ID" ]]; then
  echo "Usage: $0 <deployment-id>   (e.g. ws-slot00)" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SSM_KUBECONFIG_PATH="/workshop/${DEPLOYMENT_ID}/kubeconfig"
THING_GROUP="${DEPLOYMENT_ID}-devices"

# ── Fast path: cluster already up ────────────────────────────────────────────
if aws ssm get-parameter --name "$SSM_KUBECONFIG_PATH" >/dev/null 2>&1; then
  echo ">>> K3s already up for ${DEPLOYMENT_ID} (${SSM_KUBECONFIG_PATH} exists) — skipping launch."
  exit 0
fi

# ── Resolve the shared platform bucket from the CFN export ───────────────────
S3_BUCKET=$(aws cloudformation list-exports \
  --query "Exports[?Name=='workshop-platform-bucket-name'].Value" \
  --output text)
if [[ -z "$S3_BUCKET" || "$S3_BUCKET" == "None" ]]; then
  echo "ERROR: could not resolve workshop-platform-bucket-name CFN export." >&2
  exit 1
fi

# ── Stage the job handler script + job document to S3 ────────────────────────
echo ">>> Uploading deploy-k3s.sh to s3://${S3_BUCKET}/job-scripts/${DEPLOYMENT_ID}/deploy-k3s.sh"
aws s3 cp "$REPO_ROOT/job-scripts/deploy-k3s.sh" \
  "s3://${S3_BUCKET}/job-scripts/${DEPLOYMENT_ID}/deploy-k3s.sh"

JOB_DOC=$(mktemp)
trap 'rm -f "$JOB_DOC"' EXIT
cat > "$JOB_DOC" <<EOF
{
  "version": "1.0",
  "steps": [
    {
      "action": {
        "name": "deploy-k3s",
        "type": "runHandler",
        "input": {
          "handler": "run-script.sh",
          "args": ["s3://${S3_BUCKET}/job-scripts/${DEPLOYMENT_ID}/deploy-k3s.sh"]
        },
        "runAsUser": ""
      }
    }
  ]
}
EOF

echo ">>> Uploading job document to s3://${S3_BUCKET}/${DEPLOYMENT_ID}/job-docs/deploy-k3s-job-doc.json"
aws s3 cp "$JOB_DOC" \
  "s3://${S3_BUCKET}/${DEPLOYMENT_ID}/job-docs/deploy-k3s-job-doc.json"

# ── Create the IoT Job targeting the slot's device Thing Group ───────────────
TARGET_ARN=$(aws iot describe-thing-group \
  --thing-group-name "$THING_GROUP" \
  --query thingGroupArn --output text)

JOB_ID="${DEPLOYMENT_ID}-deploy-k3s-$(date +%s)"
echo ">>> Creating IoT Job $JOB_ID (target $THING_GROUP, 45-min in-progress timeout)…"
aws iot create-job \
  --job-id "$JOB_ID" \
  --targets "$TARGET_ARN" \
  --document-source "s3://${S3_BUCKET}/${DEPLOYMENT_ID}/job-docs/deploy-k3s-job-doc.json" \
  --timeout-config '{"inProgressTimeoutInMinutes":45}' \
  --output json >/dev/null

# ── Poll for the kubeconfig to appear in SSM (server node wrote it) ──────────
# The server (lowest instance-id) installs K3s (~10-20 min) then writes the
# kubeconfig; agents join afterwards. We gate on the kubeconfig param rather
# than job status so the caller has a directly-usable artifact when we return.
echo ">>> Waiting for ${SSM_KUBECONFIG_PATH} (K3s server ~10-20 min)…"
for attempt in $(seq 1 90); do   # 90 × 20s = 30 min
  if aws ssm get-parameter --name "$SSM_KUBECONFIG_PATH" >/dev/null 2>&1; then
    echo ">>> K3s kubeconfig present in SSM after ~$(( attempt * 20 ))s. Cluster server ready."
    JOB_STATUS=$(aws iot describe-job --job-id "$JOB_ID" \
      --query 'job.status' --output text 2>/dev/null || echo UNKNOWN)
    echo ">>> IoT Job $JOB_ID status: $JOB_STATUS (agents may still be joining)."
    exit 0
  fi
  echo "  waiting… (attempt $attempt/90)"
  sleep 20
done

echo "ERROR: kubeconfig did not appear in SSM within 30 min. Check IoT Job $JOB_ID executions." >&2
exit 1
