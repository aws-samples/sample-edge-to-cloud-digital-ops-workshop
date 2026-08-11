#!/usr/bin/env bash
# Automates the Session-04 cloud analytics deploy (#159) — the one-command
# replacement for the ~10 manual steps in workshop/04-analytics/block-1-deploy.md
# plus the manual `sed | psql` DDL apply in block-2-risingwave.md.
#
# Usage:
#   scripts/deploy-cloud-analytics.sh --deployment-id ws-slot00
#   scripts/deploy-cloud-analytics.sh --deployment-id ws-slot00 --skip-cluster-scoped
#
# Idempotent — every step is safe to re-run (kubectl apply / helm upgrade
# --install / CREATE ... IF NOT EXISTS DDL / --if-not-exists topics). Exits 0
# on a repeat run against an already-deployed slot.
#
# --migrate-risingwave-meta: required, opt-in flag to move a slot that still
# has the old in-memory-backed RisingWave meta store onto the durable
# PostgreSQL one. RisingWave's validating webhook forbids changing
# spec.metaStore on an existing CR, so this deletes the CR and clears its S3
# Hummock state (destructive to RW state only — TimescaleDB is the system of
# record) before letting Helm recreate it fresh. Without this flag, the
# script fails fast on such a slot rather than silently destroying state. A
# fresh slot with no existing CR is never affected by this flag.
#
# Splits into two kinds of work, same distinction block-1 already draws:
#   - Cluster-scoped, run once per EKS cluster by whoever has cluster-admin
#     (cert-manager, risingwave-operator, cnpg operator, default StorageClass).
#     Skippable with --skip-cluster-scoped for a participant who only has
#     namespace-scoped access (WorkshopParticipantRole-<id>) and knows these
#     are already installed.
#   - Namespace-scoped, run once per slot (everything else — this is the part
#     folded into scripts/sandbox.sh's per-slot pre-warm).
set -euo pipefail

DEPLOYMENT_ID=""
SKIP_CLUSTER_SCOPED=false
DASHBOARD_IMAGE=""
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
MIGRATE_RISINGWAVE_META=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deployment-id)          DEPLOYMENT_ID="$2"; shift 2 ;;
    --skip-cluster-scoped)     SKIP_CLUSTER_SCOPED=true; shift ;;
    --dashboard-image)         DASHBOARD_IMAGE="$2"; shift 2 ;;
    --region)                   REGION="$2"; shift 2 ;;
    --migrate-risingwave-meta)  MIGRATE_RISINGWAVE_META=true; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$DEPLOYMENT_ID" ]]; then
  echo "Usage: $0 --deployment-id <ws-slotNN> [--skip-cluster-scoped] [--dashboard-image <repo:tag>] [--migrate-risingwave-meta]" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo ">>> Cloud analytics deploy — deployment ID: ${DEPLOYMENT_ID}"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# ── 1. kubectl access to the shared EKS cluster ─────────────────────────────
echo ">>> Configuring kubectl for workshop-eks..."
aws eks update-kubeconfig --region "$REGION" --name workshop-eks >/dev/null
kubectl create namespace "$DEPLOYMENT_ID" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

# ── 2. Cluster-scoped installs (skip if a participant without cluster-admin) ─
if [[ "$SKIP_CLUSTER_SCOPED" == "false" ]]; then
  echo ">>> [cluster-scoped] Ensuring default gp3 StorageClass..."
  if ! kubectl get storageclass gp3 >/dev/null 2>&1; then
    kubectl apply -f - <<'EOF'
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
parameters:
  type: gp3
  encrypted: "true"
EOF
  else
    echo "    gp3 StorageClass already present."
  fi

  echo ">>> [cluster-scoped] Ensuring cert-manager..."
  if ! kubectl get deployment cert-manager -n cert-manager >/dev/null 2>&1; then
    kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml
    kubectl wait --for=condition=Established \
      crd/certificates.cert-manager.io crd/issuers.cert-manager.io --timeout=120s
  else
    echo "    cert-manager already present."
  fi

  echo ">>> [cluster-scoped] Ensuring risingwave-operator..."
  helm repo add risingwavelabs https://risingwavelabs.github.io/helm-charts >/dev/null
  helm repo update risingwavelabs >/dev/null
  helm upgrade --install risingwave-operator risingwavelabs/risingwave-operator \
    --namespace risingwave-system --create-namespace \
    -f "$REPO_ROOT/helm/risingwave-values.yaml" >/dev/null
  kubectl wait --for=condition=available deployment/risingwave-operator \
    -n risingwave-system --timeout=120s

  echo ">>> [cluster-scoped] Ensuring cloudnative-pg operator..."
  helm repo add cloudnative-pg https://cloudnative-pg.github.io/charts >/dev/null
  helm repo update cloudnative-pg >/dev/null
  helm upgrade --install cnpg cloudnative-pg/cloudnative-pg \
    --namespace cnpg-system --create-namespace >/dev/null
  kubectl wait --for=condition=available deployment/cnpg-cloudnative-pg \
    -n cnpg-system --timeout=120s

  # ── kube-prometheus-stack — ONE Prometheus + Grafana for the whole shared
  # cluster. Installs the monitoring.coreos.com CRDs (PodMonitor/ServiceMonitor)
  # that every per-slot cloud-analytics release then emits monitors against, so
  # this MUST run before the first slot's `helm install`. Idempotent.
  echo ">>> [cluster-scoped] Ensuring kube-prometheus-stack (Prometheus + Grafana)..."
  helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null
  helm repo update prometheus-community >/dev/null
  helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
    --namespace monitoring --create-namespace \
    -f "$REPO_ROOT/helm/monitoring-values-cloud.yaml" >/dev/null
  kubectl wait --for=condition=available deployment/monitoring-grafana \
    -n monitoring --timeout=300s || \
    echo "    (Grafana not ready yet — Prometheus CRDs are installed regardless; continuing.)"
else
  echo ">>> --skip-cluster-scoped passed — assuming gp3/cert-manager/risingwave-operator/cnpg/kube-prometheus-stack are already installed."
fi

# ── 3. MSK credentials + topics ─────────────────────────────────────────────
echo ">>> Fetching MSK credentials and bootstrap brokers..."
MSK_CLUSTER_ARN=$(aws cloudformation list-exports \
  --query "Exports[?Name=='workshop-platform-msk-arn'].Value" --output text)
if [[ -z "$MSK_CLUSTER_ARN" || "$MSK_CLUSTER_ARN" == "None" ]]; then
  echo "ERROR: could not resolve workshop-platform-msk-arn CFN export." >&2
  exit 1
fi

MSK_PASS=$(aws secretsmanager get-secret-value \
  --secret-id "AmazonMSK_workshop-${DEPLOYMENT_ID}" \
  --query SecretString --output text | python3 -c 'import sys,json; print(json.load(sys.stdin)["password"])')
MSK_USER="workshop-${DEPLOYMENT_ID}"
MSK_BOOTSTRAP=$(aws kafka get-bootstrap-brokers \
  --cluster-arn "$MSK_CLUSTER_ARN" --region "$REGION" \
  --query BootstrapBrokerStringSaslScram --output text)

kubectl create secret generic msk-credentials \
  --namespace "$DEPLOYMENT_ID" \
  --from-literal=MSK_USERNAME="$MSK_USER" \
  --from-literal=MSK_PASSWORD="$MSK_PASS" \
  --from-literal=MSK_BOOTSTRAP_SERVERS="$MSK_BOOTSTRAP" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

echo ">>> Ensuring MSK topics exist (MSK is VPC-private — run from inside the cluster)..."
kubectl -n "$DEPLOYMENT_ID" delete pod kafka-admin --ignore-not-found >/dev/null
kubectl -n "$DEPLOYMENT_ID" run kafka-admin --restart=Never --image=python:3.12-slim \
  --command -- sleep 900 >/dev/null
kubectl -n "$DEPLOYMENT_ID" wait --for=condition=Ready pod/kafka-admin --timeout=120s
kubectl -n "$DEPLOYMENT_ID" exec kafka-admin -- pip install --quiet kafka-python

kubectl -n "$DEPLOYMENT_ID" exec -i kafka-admin -- \
  env MSK_BOOTSTRAP="$MSK_BOOTSTRAP" MSK_USER="$MSK_USER" MSK_PASS="$MSK_PASS" DEPLOYMENT_ID="$DEPLOYMENT_ID" python3 - <<'PYEOF'
import os
from kafka.admin import KafkaAdminClient, NewTopic
from kafka.errors import TopicAlreadyExistsError
admin = KafkaAdminClient(
    bootstrap_servers=os.environ["MSK_BOOTSTRAP"].split(","),
    security_protocol="SASL_SSL", sasl_mechanism="SCRAM-SHA-512",
    sasl_plain_username=os.environ["MSK_USER"], sasl_plain_password=os.environ["MSK_PASS"])
deployment_id = os.environ["DEPLOYMENT_ID"]
topics = ["sensors.raw.sim", "raw.telemetry"] + [
    f"sensors.raw.{deployment_id}-edge-{i}" for i in range(3)
]
for t in topics:
    try:
        admin.create_topics([NewTopic(name=t, num_partitions=3, replication_factor=2)])
        print("created", t)
    except TopicAlreadyExistsError:
        print("exists", t)
print("TOPICS:", sorted(admin.list_topics()))
PYEOF
kubectl -n "$DEPLOYMENT_ID" delete pod kafka-admin >/dev/null

# ── 4. RisingWave S3 state bucket + IRSA role lookup ────────────────────────
# The service account itself (with the IRSA role-arn annotation) is created
# by the chart (helm/cloud-analytics/templates/risingwave-cr.yaml) — Helm must
# be its sole owner, so we only resolve the role ARN here and pass it through
# via --set below rather than kubectl-applying the ServiceAccount ourselves.
STATE_BUCKET="workshop-${DEPLOYMENT_ID}-${ACCOUNT_ID}-risingwave-state"
echo ">>> Ensuring RisingWave state bucket ${STATE_BUCKET}..."
aws s3api head-bucket --bucket "$STATE_BUCKET" 2>/dev/null || \
  aws s3 mb "s3://${STATE_BUCKET}" --region "$REGION"

RISINGWAVE_S3_ROLE_ARN=$(aws cloudformation list-exports \
  --query "Exports[?Name=='workshop-platform-risingwave-s3-role-arn'].Value" --output text)
if [[ -z "$RISINGWAVE_S3_ROLE_ARN" || "$RISINGWAVE_S3_ROLE_ARN" == "None" ]]; then
  echo "ERROR: could not resolve workshop-platform-risingwave-s3-role-arn CFN export." >&2
  exit 1
fi

# ── 4b. Adopt a stale non-Helm risingwave-cloud ServiceAccount, if present ──
# A leftover SA from an earlier partial run / pre-Helm manual apply (#175)
# lacks the app.kubernetes.io/managed-by=Helm label + meta.helm.sh/release-*
# annotations Helm requires before it will take ownership of an existing
# object, so `helm install` refuses it outright. Stamp that adoption metadata
# on unconditionally (idempotent — a no-op on a SA Helm already owns, and a
# no-op when the SA doesn't exist yet on a truly fresh slot).
if kubectl get serviceaccount risingwave-cloud -n "$DEPLOYMENT_ID" >/dev/null 2>&1; then
  echo ">>> Adopting pre-existing risingwave-cloud ServiceAccount into the Helm release..."
  kubectl label serviceaccount risingwave-cloud -n "$DEPLOYMENT_ID" \
    app.kubernetes.io/managed-by=Helm --overwrite >/dev/null
  kubectl annotate serviceaccount risingwave-cloud -n "$DEPLOYMENT_ID" \
    meta.helm.sh/release-name=cloud-analytics \
    meta.helm.sh/release-namespace="$DEPLOYMENT_ID" --overwrite >/dev/null
fi

# ── 4c. Migrate an existing memory-backed RisingWave meta store, if any ─────
# The RisingWave validating webhook forbids changing spec.metaStore in place
# on an existing CR ("meta store must be kept consistent"), so a slot already
# running the old in-memory meta store can't simply be `helm upgrade`d onto
# the durable PostgreSQL one below — the webhook rejects the upgrade outright.
# The only path forward is to delete the CR and let Helm recreate it fresh,
# but the S3 Hummock state left behind (hummock/cluster_id/0) still names the
# old in-memory cluster_id and would collide with the new one meta mints on
# recreation — so migrating also means clearing that state. RW state is
# expendable by design (TimescaleDB is the system of record), but destroying
# it is a call only the operator should make explicitly, never a silent side
# effect of a routine deploy — hence the dedicated opt-in flag, same guard
# philosophy as --delete-platform-stack in e2e/doc-runner-cli.ts.
RW_CR_NAME="risingwave-cloud"
if kubectl get risingwave "$RW_CR_NAME" -n "$DEPLOYMENT_ID" >/dev/null 2>&1; then
  EXISTING_META_MEMORY=$(kubectl get risingwave "$RW_CR_NAME" -n "$DEPLOYMENT_ID" \
    -o jsonpath='{.spec.metaStore.memory}' 2>/dev/null || true)
  if [[ -n "$EXISTING_META_MEMORY" ]]; then
    if [[ "$MIGRATE_RISINGWAVE_META" == "true" ]]; then
      echo ">>> [migrate] Existing RisingWave CR '${RW_CR_NAME}' uses an in-memory meta store; deleting it and clearing its S3 Hummock state so it can be recreated on the durable PostgreSQL meta store (--migrate-risingwave-meta)..."
      kubectl delete risingwave "$RW_CR_NAME" -n "$DEPLOYMENT_ID" --ignore-not-found --wait=true
      echo ">>> [migrate] Clearing s3://${STATE_BUCKET} — the leftover hummock/cluster_id marker from the old in-memory meta would otherwise collide with the new cluster_id. This is safe: RW state is expendable, TimescaleDB is the system of record."
      aws s3 rm "s3://${STATE_BUCKET}" --recursive --region "$REGION" >/dev/null
    else
      echo "ERROR: existing RisingWave CR '${RW_CR_NAME}' uses an in-memory meta store." >&2
      echo "       spec.metaStore cannot be changed in place (RisingWave's validating webhook forbids it), so helm upgrade would fail." >&2
      echo "       Re-run with --migrate-risingwave-meta to delete the CR and clear its S3 state, then recreate it on the durable PostgreSQL meta store." >&2
      exit 1
    fi
  fi
fi

# ── 5. helm upgrade --install the per-slot analytics stack ──────────────────
# The dashboard image is shared across all slots (one push per code change,
# not per slot) — default to this account's ECR repo, built/pushed via
# scripts/build-cloud-dashboard.sh.
DASHBOARD_IMAGE="${DASHBOARD_IMAGE:-${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/workshop-cloud-dashboard:latest}"
DASHBOARD_REPO="${DASHBOARD_IMAGE%%:*}"
DASHBOARD_TAG="${DASHBOARD_IMAGE##*:}"

echo ">>> Deploying helm/cloud-analytics into namespace ${DEPLOYMENT_ID}..."
helm dependency update "$REPO_ROOT/helm/cloud-analytics" >/dev/null
# NOTE: intentionally NOT `--wait`. The dashboard/redpanda-connect pods block
# (non-optional initContainer / secretRef) on the timescaledb-credentials +
# timescaledb-dashboard-env secrets, which are derived below from the password
# CNPG auto-generates in the "<crName>-app" secret. With `--wait`, Helm would
# hold main-resource readiness *before* running the post-upgrade DSN hook —
# but that hook is exactly what unblocks readiness, so the two deadlock and
# `helm --wait` times out on a fresh slot. We drive readiness ourselves below.
helm upgrade --install cloud-analytics "$REPO_ROOT/helm/cloud-analytics" \
  --namespace "$DEPLOYMENT_ID" \
  --set deploymentId="$DEPLOYMENT_ID" \
  --set-string accountId="$ACCOUNT_ID" \
  --set awsRegion="$REGION" \
  --set dashboard.image.repository="$DASHBOARD_REPO" \
  --set dashboard.image.tag="$DASHBOARD_TAG" \
  --set risingwave.serviceAccountRoleArn="$RISINGWAVE_S3_ROLE_ARN" \
  --set-file risingwaveDdl="$REPO_ROOT/risingwave/ddl-cloud.sql" \
  --timeout 15m

# ── 6. Derive the TimescaleDB DSN secrets from CNPG's generated password ────
# CNPG creates "timescaledb-cloud-app" once the cluster bootstraps its primary.
# Build the two consumer secrets from it here (idempotent) rather than relying
# on the Helm post-upgrade hook, which cannot run under `--wait` (see above).
TSDB_CR="timescaledb-cloud"
echo ">>> Waiting for CNPG-generated ${TSDB_CR}-app secret (primary bootstrap ~1-3 min)..."
for _ in $(seq 1 120); do
  kubectl get secret "${TSDB_CR}-app" -n "$DEPLOYMENT_ID" >/dev/null 2>&1 && break
  sleep 5
done
TSDB_PASSWORD=$(kubectl get secret "${TSDB_CR}-app" -n "$DEPLOYMENT_ID" \
  -o jsonpath='{.data.password}' 2>/dev/null | base64 -d)
if [[ -z "$TSDB_PASSWORD" ]]; then
  echo "ERROR: ${TSDB_CR}-app secret never appeared — CNPG cluster failed to bootstrap." >&2
  exit 1
fi
TSDB_DSN="postgres://workshop:${TSDB_PASSWORD}@${TSDB_CR}-rw.${DEPLOYMENT_ID}.svc:5432/edge"
echo ">>> Creating timescaledb-credentials + timescaledb-dashboard-env secrets..."
kubectl create secret generic timescaledb-credentials -n "$DEPLOYMENT_ID" \
  --from-literal=TIMESCALE_DSN="$TSDB_DSN" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic timescaledb-dashboard-env -n "$DEPLOYMENT_ID" \
  --from-literal=TIMESCALEDB_ENDPOINT="$TSDB_DSN" \
  --dry-run=client -o yaml | kubectl apply -f -

# ── 7. Drive readiness ourselves (replaces the `--wait` we dropped above) ────
echo ">>> Waiting for cloud-analytics workloads to become ready..."
kubectl rollout status -n "$DEPLOYMENT_ID" deploy/cloud-analytics-dashboard --timeout=10m
kubectl rollout status -n "$DEPLOYMENT_ID" deploy/cloud-analytics-redpanda-connect --timeout=10m

echo ">>> Cloud analytics deploy complete for ${DEPLOYMENT_ID}."
echo ">>> Port-forward the dashboard with:"
echo "      kubectl port-forward -n ${DEPLOYMENT_ID} svc/cloud-analytics-dashboard 3000:3000"
