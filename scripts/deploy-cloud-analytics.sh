#!/usr/bin/env bash
# Automates the Session-04 cloud analytics deploy (#159) — the one-command
# replacement for the ~10 manual steps in workshop/04-analytics/block-1-deploy.md
# plus the manual `sed | psql` DDL apply in block-2-risingwave.md.
#
# Usage:
#   scripts/deploy-cloud-analytics.sh --shared
#   scripts/deploy-cloud-analytics.sh --shared --skip-cluster-scoped
#   scripts/deploy-cloud-analytics.sh --deployment-id ws-slot00   # legacy per-slot mode (#253 superseded this)
#
# #253: cloud-analytics collapsed from one release PER SLOT into ONE shared
# release for the whole workshop — every slot's telemetry flows through it,
# filtered by `deployment_id` (see risingwave/ddl-cloud.sql). --shared deploys
# that one release into the shared `cloud-analytics` namespace under a dedicated
# `workshop-shared` MSK identity, instead of a per-slot namespace/identity.
# --deployment-id still exists for a rollback/one-off per-slot deploy, but the
# standard path (scripts/post-deploy-slot.sh, scripts/sandbox-all.sh) now calls
# this with --shared exactly once per account, not once per slot.
#
# Idempotent — every step is safe to re-run (kubectl apply / helm upgrade
# --install / CREATE ... IF NOT EXISTS DDL / --if-not-exists topics). Exits 0
# on a repeat run against an already-deployed slot/shared release.
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
SHARED=false
SKIP_CLUSTER_SCOPED=false
DASHBOARD_IMAGE=""
SKIP_DASHBOARD_BUILD=false
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
MIGRATE_RISINGWAVE_META=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deployment-id)          DEPLOYMENT_ID="$2"; shift 2 ;;
    --shared)                  SHARED=true; shift ;;
    --skip-cluster-scoped)     SKIP_CLUSTER_SCOPED=true; shift ;;
    --dashboard-image)         DASHBOARD_IMAGE="$2"; shift 2 ;;
    --skip-dashboard-build)     SKIP_DASHBOARD_BUILD=true; shift ;;
    --region)                   REGION="$2"; shift 2 ;;
    --migrate-risingwave-meta)  MIGRATE_RISINGWAVE_META=true; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# #253: --shared deploys the one release every slot shares. It needs no
# --deployment-id (there is no single slot), so default DEPLOYMENT_ID to the
# "shared" sentinel values.yaml already expects; NAMESPACE — the one thing
# that actually changes per-mode — is derived from it below.
if [[ "$SHARED" == "true" ]]; then
  DEPLOYMENT_ID="${DEPLOYMENT_ID:-shared}"
elif [[ -z "$DEPLOYMENT_ID" ]]; then
  echo "Usage: $0 --shared [--skip-cluster-scoped] [--dashboard-image <repo:tag>] [--skip-dashboard-build] [--migrate-risingwave-meta]" >&2
  echo "   or: $0 --deployment-id <ws-slotNN> [--skip-cluster-scoped] [--dashboard-image <repo:tag>] [--skip-dashboard-build] [--migrate-risingwave-meta]  (legacy per-slot mode)" >&2
  exit 1
fi

NAMESPACE="$DEPLOYMENT_ID"
if [[ "$SHARED" == "true" ]]; then
  NAMESPACE="cloud-analytics"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo ">>> Cloud analytics deploy — deployment ID: ${DEPLOYMENT_ID} (namespace: ${NAMESPACE})"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# ── 1. kubectl access to the shared EKS cluster ─────────────────────────────
echo ">>> Configuring kubectl for workshop-eks..."
aws eks update-kubeconfig --region "$REGION" --name workshop-eks >/dev/null
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

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

MSK_SECRET_ID="AmazonMSK_workshop-${DEPLOYMENT_ID}"
MSK_USER="workshop-${DEPLOYMENT_ID}"

if [[ "$SHARED" == "true" ]]; then
  # #253: the shared release has no CDK ParticipantStack minting+associating a
  # SCRAM secret for it (that only happens per-slot), so create+associate one
  # here, idempotently — MSK SASL/SCRAM only authenticates *associated*
  # secrets and there is no admin SCRAM user to fall back to.
  echo ">>> [shared] Ensuring MSK SCRAM secret ${MSK_SECRET_ID}..."
  MSK_SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "$MSK_SECRET_ID" \
    --query ARN --output text 2>/dev/null || true)
  if [[ -z "$MSK_SECRET_ARN" || "$MSK_SECRET_ARN" == "None" ]]; then
    MSK_SCRAM_KEY_ARN=$(aws cloudformation list-exports \
      --query "Exports[?Name=='workshop-platform-msk-scram-key-arn'].Value" --output text)
    if [[ -z "$MSK_SCRAM_KEY_ARN" || "$MSK_SCRAM_KEY_ARN" == "None" ]]; then
      echo "ERROR: could not resolve workshop-platform-msk-scram-key-arn CFN export." >&2
      exit 1
    fi
    GENERATED_PASSWORD=$(aws secretsmanager get-random-password \
      --exclude-punctuation --password-length 32 --query RandomPassword --output text)
    # Build the JSON in its own command substitution rather than nesting it
    # inside --secret-string "$(...)" — bash 3.2 (macOS's system /bin/bash)
    # mis-parses a nested $( … "$( … )" … ), dropping the inner double-quotes
    # that protect the {...} dict literal, which then brace-expands into two
    # broken `python3 -c` invocations (bash 4+/zsh parse it fine, which is why
    # this only breaks on facilitators' Macs and not CI). See #255.
    MSK_SECRET_JSON=$(python3 -c "import json,sys; print(json.dumps({'username': sys.argv[1], 'password': sys.argv[2]}))" "$MSK_USER" "$GENERATED_PASSWORD")
    MSK_SECRET_ARN=$(aws secretsmanager create-secret --name "$MSK_SECRET_ID" \
      --description "MSK SASL/SCRAM credentials for the shared cloud-analytics release" \
      --kms-key-id "$MSK_SCRAM_KEY_ARN" \
      --secret-string "$MSK_SECRET_JSON" \
      --query ARN --output text)
    echo "    created $MSK_SECRET_ARN"
  else
    echo "    $MSK_SECRET_ID already exists — reusing."
  fi

  # Associate, then poll list-scram-secrets until it sticks — Secrets
  # Manager/KMS eventual consistency can leave the first attempt unprocessed
  # (mirrors the retry loop in amplify/custom/participant-stack.ts:1251).
  is_associated() {
    aws kafka list-scram-secrets --cluster-arn "$MSK_CLUSTER_ARN" \
      --query "SecretArnList" --output text 2>/dev/null | tr '\t' '\n' | grep -qx "$MSK_SECRET_ARN"
  }
  if ! is_associated; then
    echo ">>> [shared] Associating $MSK_SECRET_ARN with the MSK cluster..."
    for attempt in $(seq 1 8); do
      aws kafka batch-associate-scram-secret --cluster-arn "$MSK_CLUSTER_ARN" \
        --secret-arn-list "$MSK_SECRET_ARN" >/dev/null 2>&1 || true
      is_associated && { echo "    associated after attempt $attempt"; break; }
      echo "    attempt $attempt not yet associated — retrying..."
      sleep 15
    done
    is_associated || { echo "ERROR: failed to associate $MSK_SECRET_ARN with the MSK cluster after 8 attempts." >&2; exit 1; }
  else
    echo "    already associated with the MSK cluster."
  fi
fi

MSK_PASS=$(aws secretsmanager get-secret-value \
  --secret-id "$MSK_SECRET_ID" \
  --query SecretString --output text | python3 -c 'import sys,json; print(json.load(sys.stdin)["password"])')
MSK_BOOTSTRAP=$(aws kafka get-bootstrap-brokers \
  --cluster-arn "$MSK_CLUSTER_ARN" --region "$REGION" \
  --query BootstrapBrokerStringSaslScram --output text)

kubectl create secret generic msk-credentials \
  --namespace "$NAMESPACE" \
  --from-literal=MSK_USERNAME="$MSK_USER" \
  --from-literal=MSK_PASSWORD="$MSK_PASS" \
  --from-literal=MSK_BOOTSTRAP_SERVERS="$MSK_BOOTSTRAP" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

echo ">>> Ensuring MSK topics exist (MSK is VPC-private — run from inside the cluster)..."
kubectl -n "$NAMESPACE" delete pod kafka-admin --ignore-not-found >/dev/null
kubectl -n "$NAMESPACE" run kafka-admin --restart=Never --image=python:3.12-slim \
  --command -- sleep 900 >/dev/null
kubectl -n "$NAMESPACE" wait --for=condition=Ready pod/kafka-admin --timeout=120s
kubectl -n "$NAMESPACE" exec kafka-admin -- pip install --quiet kafka-python

# #253: in shared mode, the per-slot device topics (sensors.raw.<slot>-edge-N)
# are each slot's own concern (created per-slot elsewhere) — this release only
# needs the two topics every slot publishes onto: sensors.raw.sim, raw.telemetry.
if [[ "$SHARED" == "true" ]]; then
  TOPICS_PY='["sensors.raw.sim", "raw.telemetry"]'
else
  TOPICS_PY="[\"sensors.raw.sim\", \"raw.telemetry\"] + [f\"sensors.raw.${DEPLOYMENT_ID}-edge-{i}\" for i in range(3)]"
fi

kubectl -n "$NAMESPACE" exec -i kafka-admin -- \
  env MSK_BOOTSTRAP="$MSK_BOOTSTRAP" MSK_USER="$MSK_USER" MSK_PASS="$MSK_PASS" TOPICS_PY="$TOPICS_PY" python3 - <<'PYEOF'
import os
from kafka.admin import KafkaAdminClient, NewTopic
from kafka.errors import TopicAlreadyExistsError
admin = KafkaAdminClient(
    bootstrap_servers=os.environ["MSK_BOOTSTRAP"].split(","),
    security_protocol="SASL_SSL", sasl_mechanism="SCRAM-SHA-512",
    sasl_plain_username=os.environ["MSK_USER"], sasl_plain_password=os.environ["MSK_PASS"])
topics = eval(os.environ["TOPICS_PY"])
for t in topics:
    try:
        admin.create_topics([NewTopic(name=t, num_partitions=3, replication_factor=2)])
        print("created", t)
    except TopicAlreadyExistsError:
        print("exists", t)
print("TOPICS:", sorted(admin.list_topics()))
PYEOF
kubectl -n "$NAMESPACE" delete pod kafka-admin >/dev/null

# ── 3b. Timestream for InfluxDB admin credentials (#229/#230) ───────────────
# The shared managed hot tier. Surface its endpoint + admin creds into an
# in-cluster `influxdb-admin` Secret that the chart's influxdb-provision-job
# uses to mint the per-slot bucket + token (the instance is VPC-private, so
# that minting can't run here). If the #229 platform exports aren't present yet
# (a platform stack deployed before this epic), skip InfluxDB cleanly and turn
# the Telegraf sink off for this slot rather than failing the whole deploy.
TELEGRAF_ENABLED=true
INFLUX_ENDPOINT=$(aws cloudformation list-exports \
  --query "Exports[?Name=='workshop-platform-influxdb-endpoint'].Value" --output text 2>/dev/null || true)
if [[ -z "$INFLUX_ENDPOINT" || "$INFLUX_ENDPOINT" == "None" ]]; then
  echo ">>> WARN: workshop-platform-influxdb-endpoint export not found — the platform"
  echo "          stack predates epic #233. Deploying with the Telegraf/InfluxDB tier OFF."
  TELEGRAF_ENABLED=false
else
  INFLUX_ADMIN_SECRET_ARN=$(aws cloudformation list-exports \
    --query "Exports[?Name=='workshop-platform-influxdb-admin-secret-arn'].Value" --output text)
  INFLUX_ORG=$(aws cloudformation list-exports \
    --query "Exports[?Name=='workshop-platform-influxdb-org'].Value" --output text)
  INFLUX_ADMIN_JSON=$(aws secretsmanager get-secret-value \
    --secret-id "$INFLUX_ADMIN_SECRET_ARN" --query SecretString --output text)
  INFLUX_ADMIN_USER=$(echo "$INFLUX_ADMIN_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["username"])')
  INFLUX_ADMIN_PASS=$(echo "$INFLUX_ADMIN_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["password"])')
  # attrEndpoint is a bare host; the InfluxDB v2 API is HTTPS on 8086.
  INFLUX_URL="https://${INFLUX_ENDPOINT}:8086"
  echo ">>> Creating influxdb-admin secret (endpoint ${INFLUX_URL}, org ${INFLUX_ORG})..."
  kubectl create secret generic influxdb-admin \
    --namespace "$NAMESPACE" \
    --from-literal=INFLUX_URL="$INFLUX_URL" \
    --from-literal=INFLUX_ORG="$INFLUX_ORG" \
    --from-literal=INFLUX_ADMIN_USERNAME="$INFLUX_ADMIN_USER" \
    --from-literal=INFLUX_ADMIN_PASSWORD="$INFLUX_ADMIN_PASS" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
fi

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
if kubectl get serviceaccount risingwave-cloud -n "$NAMESPACE" >/dev/null 2>&1; then
  echo ">>> Adopting pre-existing risingwave-cloud ServiceAccount into the Helm release..."
  kubectl label serviceaccount risingwave-cloud -n "$NAMESPACE" \
    app.kubernetes.io/managed-by=Helm --overwrite >/dev/null
  kubectl annotate serviceaccount risingwave-cloud -n "$NAMESPACE" \
    meta.helm.sh/release-name=cloud-analytics \
    meta.helm.sh/release-namespace="$NAMESPACE" --overwrite >/dev/null
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
if kubectl get risingwave "$RW_CR_NAME" -n "$NAMESPACE" >/dev/null 2>&1; then
  EXISTING_META_MEMORY=$(kubectl get risingwave "$RW_CR_NAME" -n "$NAMESPACE" \
    -o jsonpath='{.spec.metaStore.memory}' 2>/dev/null || true)
  if [[ -n "$EXISTING_META_MEMORY" ]]; then
    if [[ "$MIGRATE_RISINGWAVE_META" == "true" ]]; then
      echo ">>> [migrate] Existing RisingWave CR '${RW_CR_NAME}' uses an in-memory meta store; deleting it and clearing its S3 Hummock state so it can be recreated on the durable PostgreSQL meta store (--migrate-risingwave-meta)..."
      kubectl delete risingwave "$RW_CR_NAME" -n "$NAMESPACE" --ignore-not-found --wait=true
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

# ── 5. Resolve the dashboard image to an immutable, current tag ─────────────
# #197: the old default pinned `:latest` with imagePullPolicy: IfNotPresent and
# never rebuilt on redeploy, so an existing slot kept serving whatever image
# was baked into `:latest` when the node first pulled it — a stale, pre-#187
# image that lacked the Query Latency chart. Fix: tag by the current commit's
# short SHA (immutable per code change) and rebuild+push it as part of the
# deploy, so `helm upgrade` always references a fresh tag Kubernetes must pull.
#
# Precedence:
#   1. --dashboard-image <repo:tag>  → use exactly that (explicit escape hatch;
#      no rebuild — the caller owns that image).
#   2. otherwise → build+push cloud-dashboard under this commit's short SHA via
#      scripts/build-cloud-dashboard.sh, then reference that immutable tag.
#      --skip-dashboard-build reuses an already-pushed SHA tag (no rebuild).
DASHBOARD_REPO_NAME="workshop-cloud-dashboard"
if [[ -n "$DASHBOARD_IMAGE" ]]; then
  DASHBOARD_REPO="${DASHBOARD_IMAGE%%:*}"
  DASHBOARD_TAG="${DASHBOARD_IMAGE##*:}"
  echo ">>> Using explicitly-provided dashboard image ${DASHBOARD_IMAGE} (no rebuild)."
else
  DASHBOARD_TAG=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)
  DASHBOARD_REPO="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${DASHBOARD_REPO_NAME}"
  if [[ "$SKIP_DASHBOARD_BUILD" == "true" ]]; then
    echo ">>> --skip-dashboard-build: assuming ${DASHBOARD_REPO}:${DASHBOARD_TAG} is already in ECR."
  else
    echo ">>> Building + pushing current dashboard image ${DASHBOARD_REPO}:${DASHBOARD_TAG} (immutable SHA tag)..."
    "$SCRIPT_DIR/build-cloud-dashboard.sh" --tag "$DASHBOARD_TAG" --region "$REGION"
  fi
fi
echo ">>> Dashboard image: ${DASHBOARD_REPO}:${DASHBOARD_TAG}"

echo ">>> Deploying helm/cloud-analytics into namespace ${NAMESPACE}..."
helm dependency update "$REPO_ROOT/helm/cloud-analytics" >/dev/null
# NOTE: intentionally NOT `--wait`. The dashboard/redpanda-connect pods block
# (non-optional initContainer / secretRef) on the timescaledb-credentials +
# timescaledb-dashboard-env secrets, which are derived below from the password
# CNPG auto-generates in the "<crName>-app" secret. With `--wait`, Helm would
# hold main-resource readiness *before* running the post-upgrade DSN hook —
# but that hook is exactly what unblocks readiness, so the two deadlock and
# `helm --wait` times out on a fresh slot. We drive readiness ourselves below.
helm upgrade --install cloud-analytics "$REPO_ROOT/helm/cloud-analytics" \
  --namespace "$NAMESPACE" \
  --set deploymentId="$DEPLOYMENT_ID" \
  --set-string accountId="$ACCOUNT_ID" \
  --set awsRegion="$REGION" \
  --set dashboard.image.repository="$DASHBOARD_REPO" \
  --set dashboard.image.tag="$DASHBOARD_TAG" \
  --set risingwave.serviceAccountRoleArn="$RISINGWAVE_S3_ROLE_ARN" \
  --set telegraf.enabled="$TELEGRAF_ENABLED" \
  --set-file risingwaveDdl="$REPO_ROOT/risingwave/ddl-cloud.sql" \
  --timeout 15m

# ── 6. Derive the TimescaleDB DSN secrets from CNPG's generated password ────
# CNPG creates "timescaledb-cloud-app" once the cluster bootstraps its primary.
# Build the two consumer secrets from it here (idempotent) rather than relying
# on the Helm post-upgrade hook, which cannot run under `--wait` (see above).
TSDB_CR="timescaledb-cloud"
echo ">>> Waiting for CNPG-generated ${TSDB_CR}-app secret (primary bootstrap ~1-3 min)..."
for _ in $(seq 1 120); do
  kubectl get secret "${TSDB_CR}-app" -n "$NAMESPACE" >/dev/null 2>&1 && break
  sleep 5
done
TSDB_PASSWORD=$(kubectl get secret "${TSDB_CR}-app" -n "$NAMESPACE" \
  -o jsonpath='{.data.password}' 2>/dev/null | base64 -d)
if [[ -z "$TSDB_PASSWORD" ]]; then
  echo "ERROR: ${TSDB_CR}-app secret never appeared — CNPG cluster failed to bootstrap." >&2
  exit 1
fi
TSDB_DSN="postgres://workshop:${TSDB_PASSWORD}@${TSDB_CR}-rw.${NAMESPACE}.svc:5432/edge"
echo ">>> Creating timescaledb-credentials + timescaledb-dashboard-env secrets..."
kubectl create secret generic timescaledb-credentials -n "$NAMESPACE" \
  --from-literal=TIMESCALE_DSN="$TSDB_DSN" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic timescaledb-dashboard-env -n "$NAMESPACE" \
  --from-literal=TIMESCALEDB_ENDPOINT="$TSDB_DSN" \
  --dry-run=client -o yaml | kubectl apply -f -

# ── 7. Drive readiness ourselves (replaces the `--wait` we dropped above) ────
echo ">>> Waiting for cloud-analytics workloads to become ready..."
kubectl rollout status -n "$NAMESPACE" deploy/cloud-analytics-dashboard --timeout=10m
kubectl rollout status -n "$NAMESPACE" deploy/cloud-analytics-redpanda-connect --timeout=10m
if [[ "$TELEGRAF_ENABLED" == "true" ]]; then
  # Telegraf blocks in its wait-for-influxdb-credentials initContainer until the
  # post-install provisioning Job mints the per-slot bucket/token — give that
  # hook time to run before we assert the sink is up.
  kubectl rollout status -n "$NAMESPACE" deploy/cloud-analytics-telegraf --timeout=10m
fi

echo ">>> Cloud analytics deploy complete for ${DEPLOYMENT_ID} (namespace ${NAMESPACE})."
echo ">>> Port-forward the dashboard with:"
echo "      kubectl port-forward -n ${NAMESPACE} svc/cloud-analytics-dashboard 3000:3000"
