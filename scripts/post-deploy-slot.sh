#!/usr/bin/env bash
# post-deploy-slot.sh — per-slot post-deploy tail, run AFTER the single
# `cdk deploy` of WorkshopPlatformStack (which now brings up the platform plus
# every slot's nested Auth/Data/Participant stacks — epic #180 / #181).
#
# Usage: scripts/post-deploy-slot.sh <deployment-id>
#
# Assumes the platform stack + this slot's nested stacks are already deployed and
# the shared IoT Device Client binary + sensor simulator are already staged in
# S3 (the caller — sandbox.sh / sandbox-all.sh / the CI orchestrator — does the
# one-time build + upload). Idempotent: safe to re-run against a live slot.
#
# Steps (formerly inline in sandbox.sh):
#   1. Wait for the 3 EC2 devices to self-register via fleet provisioning
#   2. Seed initial device-config + $package shadows
#   3. Re-push the current telemetry-v2.sh IoT Job (scripts/push-telemetry-job.sh)
#   4. Pre-warm the edge K3s cluster (scripts/launch-k3s.sh)
#   5. Pre-warm the cloud analytics stack (scripts/deploy-cloud-analytics.sh)

set -euo pipefail

DEPLOYMENT_ID="${1:-}"
if [[ -z "$DEPLOYMENT_ID" ]]; then
  echo "Usage: $0 <deployment-id>" >&2
  exit 1
fi

HERE="$(dirname "$0")"

# ── Seed initial device-config and $package shadows ──────────────────────────
# EC2 instances self-register via fleet provisioning on first boot. Poll until
# all 3 things appear in the registry, then write the initial shadows so fleet
# indexing queries work before participants run any IoT Job.
echo ">>> [$DEPLOYMENT_ID] Waiting for devices to self-register via fleet provisioning..."
IOT_ENDPOINT=$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text)
THING_NAMES=()
for attempt in $(seq 1 60); do
  THING_NAMES=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && THING_NAMES+=("$line")
  done < <(aws iot list-things-in-thing-group \
    --thing-group-name "${DEPLOYMENT_ID}-devices" \
    --query "things[]" --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true)
  echo "  [$DEPLOYMENT_ID] ${#THING_NAMES[@]}/3 devices registered (attempt $attempt/60)..."
  [[ "${#THING_NAMES[@]}" -ge 3 ]] && break
  sleep 10
done

if [[ "${#THING_NAMES[@]}" -lt 3 ]]; then
  echo "WARNING: [$DEPLOYMENT_ID] Only ${#THING_NAMES[@]} device(s) registered after 10 min — seeding shadows for those that exist."
fi

for THING in "${THING_NAMES[@]+"${THING_NAMES[@]}"}"; do
  echo "  [$DEPLOYMENT_ID] Seeding shadows for $THING..."
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
echo ">>> [$DEPLOYMENT_ID] Shadow seeding complete."

# ── Re-push the current telemetry IoT Job ────────────────────────────────────
# #248: UserData only installs the persistent-MQTT publisher (#244) on a
# device's first boot, and nothing else re-delivers job-scripts/telemetry-v2.sh
# to already-registered devices (or a device whose UserData run silently
# regressed) on a plain redeploy. Push it here, every deploy, so the current
# coprocess/mqtt-publisher.py form is authoritative for the whole fleet
# regardless of what any individual device's boot happened to install.
if [[ "${#THING_NAMES[@]}" -ge 1 ]]; then
  echo ">>> [$DEPLOYMENT_ID] Re-pushing current telemetry-v2.sh via IoT Job…"
  bash "$HERE/push-telemetry-job.sh" "$DEPLOYMENT_ID"
else
  echo ">>> [$DEPLOYMENT_ID] Skipping telemetry job push — no devices registered."
fi

# ── Pre-warm the edge K3s cluster ────────────────────────────────────────────
# Launch the K3s bootstrap IoT Job now, during the facilitator pre-deploy, so the
# cluster is already up when attendees reach session 05 — instead of costing
# ~20 min of live session wall-clock. Idempotent: skips if the kubeconfig already
# exists in SSM. See scripts/launch-k3s.sh and workshop/05-edge-infra/block-2.
if [[ "${#THING_NAMES[@]}" -ge 3 ]]; then
  echo ">>> [$DEPLOYMENT_ID] Pre-warming edge K3s cluster via IoT Job (runs during pre-deploy)…"
  bash "$HERE/launch-k3s.sh" "$DEPLOYMENT_ID"
else
  echo ">>> [$DEPLOYMENT_ID] Skipping K3s pre-warm — fewer than 3 devices registered."
fi

# ── Pre-warm the cloud analytics stack ──────────────────────────────────────
# RisingWave + TimescaleDB + Redpanda Connect + dashboard into the shared EKS
# cluster, during the facilitator pre-deploy — so it's already up when
# attendees reach session 04 instead of costing ~45 min of live session
# wall-clock. Idempotent: safe to re-run against an already-deployed slot.
# See scripts/deploy-cloud-analytics.sh and workshop/04-analytics/block-1.
echo ">>> [$DEPLOYMENT_ID] Pre-warming cloud analytics stack via scripts/deploy-cloud-analytics.sh…"
# The cluster-scoped operator installs (cert-manager, gp3, risingwave-operator,
# cnpg, kube-prometheus-stack) and the dashboard image build are SHARED, one-time
# work — not per-slot. When sandbox-all.sh fans out slots in parallel it does that
# bootstrap once on the first slot and sets these env vars for the rest, so the
# concurrent slots don't race on the same cluster-wide helm releases ("UPGRADE
# FAILED: release: already exists"). Default false → a standalone/single-slot run
# still does everything itself.
CLOUD_ANALYTICS_ARGS=(--deployment-id "$DEPLOYMENT_ID")
[[ "${POST_DEPLOY_SKIP_CLUSTER_SCOPED:-false}" == "true" ]] && CLOUD_ANALYTICS_ARGS+=(--skip-cluster-scoped)
[[ "${POST_DEPLOY_SKIP_DASHBOARD_BUILD:-false}" == "true" ]] && CLOUD_ANALYTICS_ARGS+=(--skip-dashboard-build)
bash "$HERE/deploy-cloud-analytics.sh" "${CLOUD_ANALYTICS_ARGS[@]}"

echo ">>> [$DEPLOYMENT_ID] Post-deploy tail complete."
