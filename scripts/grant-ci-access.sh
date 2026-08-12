#!/usr/bin/env bash
# grant-ci-access.sh — grant a CI/facilitator IAM role the cluster + Cognito
# access the doc-runner needs to exercise sessions 03-05 against a live slot.
#
# Two grants that the shared platform's `bootstrapClusterCreatorAdminPermissions`
# and the participant stacks do NOT cover for a principal that didn't create the
# cluster (issue #70):
#
#   1. An EKS access entry on `workshop-eks` (AmazonEKSClusterAdminPolicy,
#      cluster scope) — without it every kubectl block in 04-analytics fails with
#      "You must be logged in to the server". Note it must be the *ClusterAdmin*
#      policy, not AmazonEKSAdminPolicy: the latter maps to the built-in `admin`
#      ClusterRole (namespace-admin only), which is Forbidden from the
#      cluster-scoped operations 04-analytics/block-1-deploy performs — listing
#      nodes, creating namespaces, installing CRDs, applying a StorageClass.
#      This mirrors exactly what PlatformStack does for `eksAdminPrincipalArns`
#      (platform-stack.ts), so the durable fix is to pass the role there; this
#      script is the live/idempotent apply for a cluster that already exists.
#   2. Cognito admin write (AdminCreateUser + AdminSetUserPassword) scoped to the
#      account's user pools — needed by scripts/create-workshop-user.sh, called
#      from 03-state/block-3-ui.md.
#   3. CodeBuild trigger (StartBuild + BatchGetBuilds) scoped to the async deploy
#      orchestrator project — needed when this same role is the GitHub Actions
#      OIDC principal that deploy.yml (#183) uses to fire the fire-and-forget
#      deploy via scripts/trigger-deploy.sh. Without it the workflow's trigger
#      step fails "not authorized to perform: codebuild:StartBuild".
#
# Idempotent: re-running is safe (create-access-entry / put-role-policy no-op or
# overwrite in place).
#
# Usage:
#   scripts/grant-ci-access.sh --role-arn <arn> [--role-name <name>] [--dry-run]
#
# If --role-name is omitted it is derived from the ARN. The role name is only
# needed for the inline-policy (Cognito) grant; the EKS grant uses the ARN.
#
# Environment:
#   AWS_REGION      (default: us-east-1)
#   EKS_CLUSTER     (default: workshop-eks)
set -euo pipefail

ROLE_ARN=""
ROLE_NAME=""
DRY_RUN=false
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
EKS_CLUSTER="${EKS_CLUSTER:-workshop-eks}"
POLICY_NAME="iot-workshop-deploy"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role-arn)  ROLE_ARN="$2"; shift 2 ;;
    --role-name) ROLE_NAME="$2"; shift 2 ;;
    --dry-run)   DRY_RUN=true; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$ROLE_ARN" ]]; then
  echo "Usage: $0 --role-arn <arn> [--role-name <name>] [--dry-run]" >&2
  exit 1
fi

# Derive role name from ARN if not given: arn:aws:iam::ACCT:role/NAME
[[ -z "$ROLE_NAME" ]] && ROLE_NAME="${ROLE_ARN##*/}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

run() { if $DRY_RUN; then echo "DRY-RUN: $*"; else "$@"; fi; }

echo "=== Granting CI access to $ROLE_NAME ==="
echo "  ARN:     $ROLE_ARN"
echo "  Region:  $REGION"
echo "  Cluster: $EKS_CLUSTER"
echo ""

# ── 1. EKS access entry (cluster-scoped AmazonEKSClusterAdminPolicy) ──────────
echo "--- EKS access entry on $EKS_CLUSTER ---"
if aws eks describe-access-entry --region "$REGION" --cluster-name "$EKS_CLUSTER" \
     --principal-arn "$ROLE_ARN" >/dev/null 2>&1; then
  echo "  Access entry already exists — skipping create."
else
  run aws eks create-access-entry --region "$REGION" --cluster-name "$EKS_CLUSTER" \
    --principal-arn "$ROLE_ARN" --type STANDARD
fi
# associate-access-policy is idempotent (overwrites the scope for this policy).
run aws eks associate-access-policy --region "$REGION" --cluster-name "$EKS_CLUSTER" \
  --principal-arn "$ROLE_ARN" \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy \
  --access-scope type=cluster

# ── 2. Cognito admin write + CodeBuild deploy-trigger (inline policy) ─────────
echo "--- Cognito + CodeBuild grants on inline policy '$POLICY_NAME' ---"
POLICY_DOC=$(mktemp /tmp/ci-inline-policy-XXXXXX.json)
trap 'rm -f "$POLICY_DOC"' EXIT

if ! aws iam get-role-policy --role-name "$ROLE_NAME" --policy-name "$POLICY_NAME" \
      --query 'PolicyDocument' --output json > "$POLICY_DOC" 2>/dev/null; then
  echo "  Inline policy '$POLICY_NAME' not found on $ROLE_NAME — creating a"
  echo "  fresh policy instead."
  printf '{"Version":"2012-10-17","Statement":[]}' > "$POLICY_DOC"
fi

# ARN of the async deploy orchestrator CodeBuild project (epic #182/#183).
ORCHESTRATOR_PROJECT_ARN="arn:aws:codebuild:${REGION}:${ACCOUNT_ID}:project/workshop-deploy-orchestrator"

UPDATED=$(python3 - "$POLICY_DOC" "$ACCOUNT_ID" "$ORCHESTRATOR_PROJECT_ARN" <<'PY'
import json, sys
path, account, cb_project_arn = sys.argv[1], sys.argv[2], sys.argv[3]
doc = json.load(open(path))
doc.setdefault("Version", "2012-10-17")
stmts = doc.setdefault("Statement", [])
have = {s.get("Sid") for s in stmts}
added = []
if "CognitoWorkshopUserAdmin" not in have:
    stmts.append({
        "Sid": "CognitoWorkshopUserAdmin",
        "Effect": "Allow",
        "Resource": f"arn:aws:cognito-idp:*:{account}:userpool/*",
        "Action": ["cognito-idp:AdminCreateUser", "cognito-idp:AdminSetUserPassword"],
    })
    added.append("CognitoWorkshopUserAdmin")
if "CognitoListPools" not in have:
    # ListUserPools has no resource-level control — must be "*".
    stmts.append({
        "Sid": "CognitoListPools",
        "Effect": "Allow",
        "Resource": "*",
        "Action": "cognito-idp:ListUserPools",
    })
    added.append("CognitoListPools")
if "CodeBuildDeployTrigger" not in have:
    # Fire-and-forget deploy trigger for deploy.yml (#183): start the
    # orchestrator build and poll it. Scoped to the one project.
    stmts.append({
        "Sid": "CodeBuildDeployTrigger",
        "Effect": "Allow",
        "Resource": cb_project_arn,
        "Action": ["codebuild:StartBuild", "codebuild:BatchGetBuilds"],
    })
    added.append("CodeBuildDeployTrigger")
json.dump(doc, open(path, "w"), indent=2)
print(",".join(added) if added else "unchanged")
PY
)

if [[ "$UPDATED" != "unchanged" ]]; then
  run aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name "$POLICY_NAME" \
    --policy-document "file://$POLICY_DOC"
  echo "  Added statements to '$POLICY_NAME': $UPDATED"
else
  echo "  Cognito + CodeBuild statements already present — no change."
fi

echo ""
echo "=== Done. $ROLE_NAME can now reach $EKS_CLUSTER and manage workshop Cognito users. ==="
echo "For a durable (CDK-managed) EKS grant, also add this ARN to"
echo "eksAdminPrincipalArns when deploying WorkshopPlatformStack:"
echo "  WORKSHOP_EKS_ADMIN_PRINCIPAL_ARNS=$ROLE_ARN"
