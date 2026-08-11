#!/usr/bin/env bash
# Automates the Session-05 edge stack deploy (#193) — the one-command
# replacement for the manual steps in workshop/05-edge-infra/block-3-helm.md
# plus the edge half of block-5-observability.md (kube-prometheus-stack + the
# monitoring.enabled=true re-upgrade).
#
# The cloud equivalent is scripts/deploy-cloud-analytics.sh (#159); this mirrors
# its shape (arg parsing, idempotent helm upgrade --install, echoed next steps).
#
# Usage:
#   scripts/deploy-edge-stack.sh --deployment-id ws-slot00
#   scripts/deploy-edge-stack.sh --deployment-id ws-slot00 --skip-monitoring
#
# Idempotent — every step is safe to re-run (kubectl apply / helm upgrade
# --install). Exits 0 on a repeat run against an already-deployed slot.
#
# The edge K3s API server is VPC-private with no public ingress, so this opens
# an SSM port-forward to it by SOURCING scripts/edge-kubeconfig.sh (the same
# tunnel helper Block 3/4/5 document) and tears it down on exit — it does not
# re-implement the tunnel.
#
# Monitoring is a two-phase install because of a CRD-ordering hazard: the
# edge-stack chart defaults monitoring.enabled=false so it can be installed
# BEFORE the monitoring.coreos.com CRDs exist (rendering a PodMonitor with no
# CRD present fails `helm install` with "no matches for kind"). So this script
# (1) installs edge-stack with monitoring off, (2) installs kube-prometheus-stack
# which brings the CRDs, then (3) re-upgrades edge-stack with monitoring.enabled
# =true. --skip-monitoring stops after phase 1 (data stack only).
set -euo pipefail

DEPLOYMENT_ID=""
SKIP_MONITORING=false
REGION="${AWS_DEFAULT_REGION:-us-east-1}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deployment-id)   DEPLOYMENT_ID="$2"; shift 2 ;;
    --skip-monitoring) SKIP_MONITORING=true; shift ;;
    --region)          REGION="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$DEPLOYMENT_ID" ]]; then
  echo "Usage: $0 --deployment-id <ws-slotNN> [--skip-monitoring] [--region <region>]" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo ">>> Edge stack deploy — deployment ID: ${DEPLOYMENT_ID}"

# ── 1. kubectl access to the private K3s server over SSM ────────────────────
# Source the factored-out tunnel helper: it fetches the SSM-stored kubeconfig,
# opens local :6443 → the server node's :6443, rewrites the kubeconfig to
# 127.0.0.1 (a SAN on the K3s cert, so TLS still verifies), and exports
# KUBECONFIG. edge_kubeconfig_close tears the tunnel down; run it on exit.
echo ">>> Opening SSM tunnel to the K3s server..."
export AWS_REGION="$REGION"
# shellcheck source=scripts/edge-kubeconfig.sh disable=SC1091
source "$SCRIPT_DIR/edge-kubeconfig.sh"
edge_kubeconfig_open "$DEPLOYMENT_ID"
trap edge_kubeconfig_close EXIT

kubectl get nodes

# ── 2. MSK credentials secret in the edge namespace ─────────────────────────
echo ">>> Creating edge namespace + msk-credentials secret..."
MSK_CREDS=$(aws secretsmanager get-secret-value \
  --secret-id "AmazonMSK_workshop-${DEPLOYMENT_ID}" \
  --query SecretString --output text)
MSK_USER=$(echo "$MSK_CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin)['username'])")
MSK_PASS=$(echo "$MSK_CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin)['password'])")

kubectl create namespace edge --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic msk-credentials \
  --namespace edge \
  --from-literal=MSK_USERNAME="$MSK_USER" \
  --from-literal=MSK_PASSWORD="$MSK_PASS" \
  --dry-run=client -o yaml | kubectl apply -f -

# ── 3. Discover the two slot-specific endpoints ─────────────────────────────
# mqtt.host — the sensor-sim EC2's private IP (its Mosquitto broker is the
# ingest source). mskBootstrapServers — the SHARED MSK cluster's SASL/SCRAM
# bootstrap brokers (the WAN relay forwards sensors.raw.* there).
echo ">>> Discovering sensor-sim IP and MSK bootstrap brokers..."
SIM_IP=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=workshop-${DEPLOYMENT_ID}-sensor-sim" \
            "Name=instance-state-name,Values=running" \
  --query "Reservations[0].Instances[0].PrivateIpAddress" \
  --output text --region "$REGION")
if [[ -z "$SIM_IP" || "$SIM_IP" == "None" ]]; then
  echo "ERROR: could not resolve the sensor-sim private IP for ${DEPLOYMENT_ID}." >&2
  exit 1
fi

MSK_ARN=$(aws cloudformation list-exports \
  --query "Exports[?Name=='workshop-platform-msk-arn'].Value" --output text --region "$REGION")
if [[ -z "$MSK_ARN" || "$MSK_ARN" == "None" ]]; then
  echo "ERROR: could not resolve workshop-platform-msk-arn CFN export." >&2
  exit 1
fi
MSK_BROKERS=$(aws kafka get-bootstrap-brokers --cluster-arn "$MSK_ARN" \
  --query "BootstrapBrokerStringSaslScram" --output text --region "$REGION")
# helm --set treats commas as key separators, so escape the commas between brokers.
MSK_BROKERS_ESC="${MSK_BROKERS//,/\\,}"

# ── 4. helm upgrade --install the edge data stack (monitoring OFF) ──────────
# Phase 1: monitoring stays off (chart default) so this succeeds even before
# the monitoring.coreos.com CRDs exist. See the header comment.
echo ">>> Deploying helm/edge-stack into namespace edge (monitoring off)..."
helm dependency update "$REPO_ROOT/helm/edge-stack" >/dev/null
helm upgrade --install edge-stack "$REPO_ROOT/helm/edge-stack" \
  --namespace edge --create-namespace \
  -f "$REPO_ROOT/helm/edge-stack-values.yaml" \
  --set deploymentId="$DEPLOYMENT_ID" \
  --set mqtt.host="$SIM_IP" \
  --set mskBootstrapServers="$MSK_BROKERS_ESC" \
  --set monitoring.enabled=false

if [[ "$SKIP_MONITORING" == "true" ]]; then
  echo ">>> --skip-monitoring passed — data stack deployed, skipping kube-prometheus-stack."
else
  # ── 5. kube-prometheus-stack — standalone release in `monitoring` ─────────
  # Phase 2: brings the PodMonitor/ServiceMonitor CRDs the edge-stack monitors
  # need. Trimmed edge values (no Alertmanager, no persistence, 24h retention).
  echo ">>> Ensuring kube-prometheus-stack (Prometheus + Grafana, trimmed)..."
  helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null
  helm repo update prometheus-community >/dev/null
  helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
    --namespace monitoring --create-namespace \
    -f "$REPO_ROOT/helm/monitoring-values-edge.yaml" \
    --wait --timeout 10m

  # ── 6. Re-upgrade edge-stack with monitors ON now that the CRDs exist ─────
  # Phase 3: --reuse-values keeps the mqtt.host/mskBootstrapServers/deploymentId
  # from phase 1; only flip monitoring on so the PodMonitors/ServiceMonitors and
  # the curated Grafana dashboard get created.
  echo ">>> Re-upgrading edge-stack with monitoring.enabled=true..."
  helm upgrade edge-stack "$REPO_ROOT/helm/edge-stack" \
    --namespace edge --reuse-values \
    --set monitoring.enabled=true

  kubectl get podmonitors,servicemonitors -n edge
fi

echo ">>> Waiting for edge-stack pods to become ready..."
kubectl wait --for=condition=Ready pods --all -n edge --timeout=10m || \
  echo "    (some pods not ready yet — check 'kubectl get pods -n edge')"

echo ">>> Edge stack deploy complete for ${DEPLOYMENT_ID}."
echo ">>> The SSM tunnel closes when this script exits. To browse the cluster,"
echo "    re-open it and port-forward:"
echo "      source scripts/edge-kubeconfig.sh ${DEPLOYMENT_ID}"
if [[ "$SKIP_MONITORING" != "true" ]]; then
  echo "      kubectl port-forward -n monitoring svc/monitoring-grafana 3001:80   # Grafana (admin/workshop)"
fi
echo "      kubectl port-forward -n edge svc/edge-stack-hmi 3000:3000           # HMI"
