#!/bin/bash
# Tears down all resources for a given workshop deployment slot.
# Usage: ./scripts/teardown.sh --deployment-id ws-slot00
# The shared VPCs (workshop-edge, workshop-cloud) are intentionally preserved.
set -euo pipefail

DEPLOYMENT_ID=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --deployment-id) DEPLOYMENT_ID="$2"; shift 2 ;;
    --dry-run)       DRY_RUN=true; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [ -z "$DEPLOYMENT_ID" ]; then
  echo "Usage: $0 --deployment-id <ws-slotNN> [--dry-run]"
  exit 1
fi

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region)}}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

run() {
  if $DRY_RUN; then echo "DRY-RUN: $*"; else "$@"; fi
}

echo "=== Teardown for $DEPLOYMENT_ID (region: $REGION) ==="

# ── 1. Deactivate and delete IoT Things / Certs ───────────────────────────────
echo "--- IoT Things ---"
THINGS=$(aws iot list-things-in-thing-group \
  --region "$REGION" \
  --thing-group-name "${DEPLOYMENT_ID}-devices" \
  --query "things" --output text 2>/dev/null || true)

for THING in $THINGS; do
  echo "  Detaching and deleting $THING"
  PRINCIPALS=$(aws iot list-thing-principals --region "$REGION" --thing-name "$THING" \
    --query "principals" --output text 2>/dev/null || true)
  for PRINCIPAL in $PRINCIPALS; do
    run aws iot detach-thing-principal --region "$REGION" --thing-name "$THING" --principal "$PRINCIPAL"
    CERT_ID=$(echo "$PRINCIPAL" | cut -d/ -f2)
    run aws iot update-certificate --region "$REGION" --certificate-id "$CERT_ID" --new-status INACTIVE
    run aws iot delete-certificate --region "$REGION" --certificate-id "$CERT_ID" --force-delete
  done
  run aws iot delete-thing --region "$REGION" --thing-name "$THING"
done

# ── 2. Delete IoT Thing Group ─────────────────────────────────────────────────
run aws iot delete-thing-group --region "$REGION" --thing-group-name "${DEPLOYMENT_ID}-devices" 2>/dev/null || true

# ── 3. Disable and delete IoT Topic Rule ─────────────────────────────────────
RULE_NAME="workshop_${DEPLOYMENT_ID//-/_}_to_msk"
run aws iot delete-topic-rule --region "$REGION" --rule-name "$RULE_NAME" 2>/dev/null || true

# ── 4. Delete provisioning template ──────────────────────────────────────────
run aws iot delete-provisioning-template --region "$REGION" \
  --template-name "${DEPLOYMENT_ID}-provisioning" 2>/dev/null || true

# ── 5. Terminate EC2 instances ────────────────────────────────────────────────
echo "--- EC2 instances ---"
INSTANCE_IDS=$(aws ec2 describe-instances \
  --region "$REGION" \
  --filters "Name=tag:WorkshopDeploymentId,Values=${DEPLOYMENT_ID}" \
            "Name=instance-state-name,Values=running,stopped" \
  --query "Reservations[].Instances[].InstanceId" --output text)

if [ -n "$INSTANCE_IDS" ]; then
  echo "  Terminating: $INSTANCE_IDS"
  run aws ec2 terminate-instances --region "$REGION" --instance-ids $INSTANCE_IDS
fi

# ── 6. Delete participant namespace from shared EKS cluster (Session 4) ──────
echo "--- EKS namespace ---"
EKS_CLUSTER="workshop-eks"
EKS_STATUS=$(aws eks describe-cluster --region "$REGION" --name "$EKS_CLUSTER" \
  --query "cluster.status" --output text 2>/dev/null || echo "NOT_FOUND")

if [ "$EKS_STATUS" != "NOT_FOUND" ]; then
  aws eks update-kubeconfig --region "$REGION" --name "$EKS_CLUSTER" \
    --kubeconfig /tmp/workshop-kubeconfig 2>/dev/null || true
  if [ -f /tmp/workshop-kubeconfig ]; then
    echo "  Deleting namespace ${DEPLOYMENT_ID}"
    run env KUBECONFIG=/tmp/workshop-kubeconfig kubectl delete namespace "$DEPLOYMENT_ID" \
      --ignore-not-found --wait=false
    rm -f /tmp/workshop-kubeconfig
  fi
else
  echo "  Shared EKS cluster not found — skipping namespace deletion."
fi

# ── 7. Delete MSK cluster ─────────────────────────────────────────────────────
echo "--- MSK ---"
MSK_ARN=$(aws kafka list-clusters-v2 \
  --region "$REGION" \
  --filter-by-name "workshop-${DEPLOYMENT_ID}-msk" \
  --query "ClusterInfoList[0].ClusterArn" --output text 2>/dev/null || true)

if [ -n "$MSK_ARN" ] && [ "$MSK_ARN" != "None" ]; then
  echo "  Deleting MSK cluster: $MSK_ARN"
  run aws kafka delete-cluster --region "$REGION" --cluster-arn "$MSK_ARN"
fi

# ── 8. Empty and delete S3 buckets ────────────────────────────────────────────
echo "--- S3 ---"
for BUCKET in "workshop-${DEPLOYMENT_ID}-${ACCOUNT_ID}" "workshop-${DEPLOYMENT_ID}-${ACCOUNT_ID}-risingwave-state"; do
  if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
    echo "  Emptying $BUCKET"
    run aws s3 rm "s3://${BUCKET}" --recursive
    run aws s3api delete-bucket --bucket "$BUCKET" --region "$REGION"
  fi
done

# ── 9. Delete Athena workgroup ────────────────────────────────────────────────
run aws athena delete-work-group --region "$REGION" \
  --work-group "workshop-${DEPLOYMENT_ID}" --recursive-delete-option 2>/dev/null || true

# ── 10. Delete Secrets Manager secrets ───────────────────────────────────────
for SECRET in "/workshop/${DEPLOYMENT_ID}/claim-cert" "AmazonMSK_workshop-${DEPLOYMENT_ID}"; do
  run aws secretsmanager delete-secret --region "$REGION" \
    --secret-id "$SECRET" \
    --force-delete-without-recovery 2>/dev/null || true
done

# ── 11. SSM parameters ────────────────────────────────────────────────────────
for PARAM in \
  "/workshop/${DEPLOYMENT_ID}/k3s-token" \
  "/workshop/${DEPLOYMENT_ID}/kubeconfig" \
  "/workshop/${DEPLOYMENT_ID}/graphql-endpoint" \
  "/workshop/${DEPLOYMENT_ID}/deployment-id" \
  "/workshop/${DEPLOYMENT_ID}/claim-secret-arn" \
  "/workshop/${DEPLOYMENT_ID}/eks-cluster-name" \
  "/workshop/${DEPLOYMENT_ID}/msk-cred-secret-arn" \
  "/workshop/${DEPLOYMENT_ID}/shared-bucket-name"; do
  run aws ssm delete-parameter --region "$REGION" --name "$PARAM" 2>/dev/null || true
done

echo ""
echo "=== Teardown complete for $DEPLOYMENT_ID ==="
echo "Shared VPCs (workshop-edge, workshop-cloud) were NOT deleted."
