#!/usr/bin/env bash
# Usage: scripts/deployment-summary.sh <deployment-id> [deployment-id ...]
#
# Reads CloudFormation outputs for each completed participant stack and writes
# DEPLOYMENT_SUMMARY.md in the repo root.  Run this after sandbox-all.sh
# finishes, or call it standalone to refresh the file at any time.
#
# The file is .gitignore'd (generated artifact); keep it out of commits.

set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 <deployment-id> [deployment-id ...]" >&2
  exit 1
fi

DEPLOYMENT_IDS=("$@")
OUT_FILE="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)/DEPLOYMENT_SUMMARY.md"
REGION="${AWS_DEFAULT_REGION:-$(aws configure get region)}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
GENERATED_AT=$(date -u '+%Y-%m-%d %H:%M UTC')
DOCS_BASE_URL="https://aws-samples.github.io/sample-edge-to-cloud-digital-ops-workshop"

# ── Helper: read one CloudFormation export value ─────────────────────────────
# list-exports paginates; pipe through jq to get a single match across all pages.
cfn_export() {
  local val
  val=$(aws cloudformation list-exports \
    --output json \
    --query "Exports[?Name=='$1'].Value" \
    2>/dev/null \
    | python3 -c "import json,sys; pages=json.load(sys.stdin); print(pages[0] if pages else '')" 2>/dev/null) || true
  if [[ -z "$val" || "$val" == "None" ]]; then echo "—"; else echo "$val"; fi
}

# ── Build the markdown ────────────────────────────────────────────────────────
{
  cat <<HEADER
# Workshop Deployment Summary

Generated: ${GENERATED_AT}
Account: \`${ACCOUNT}\`
Region: \`${REGION}\`

---

## What to do with these IDs

Each **Deployment ID** is the unique identifier for one participant slot.
Share the **Workshop URL** with the participant — it pre-loads their slot ID into every code block in the docs.

| Task | Command |
|------|---------|
| Run smoke tests | \`WORKSHOP_TEST_SLOT=<id> node scripts/smoke-test.mjs\` |
| Create a participant user | \`scripts/create-workshop-user.sh <id> email@example.com\` |
| Tear down a single slot | \`scripts/teardown.sh <id>\` |
| View stack outputs in AWS Console | CloudFormation → stack \`amplify-edgedigitalopsworkshop-<id>-*\` → Outputs tab |

---

HEADER

  for ID in "${DEPLOYMENT_IDS[@]}"; do
    # Stack name: find the top-level Amplify sandbox stack for this deployment ID.
    # The ExportingStackId on any CFN export for this slot contains the stack ARN.
    STACK=$(aws cloudformation list-exports \
      --output json \
      --query "Exports[?Name=='workshop-${ID}-deployment-id'].ExportingStackId" \
      2>/dev/null \
      | python3 -c "
import json, sys
arns = json.load(sys.stdin)
if arns:
    # ARN format: arn:aws:cloudformation:region:account:stack/NAME/uuid
    print(arns[0].split('/')[1])
else:
    print('—')
" 2>/dev/null) || STACK="—"

    # Per-slot exports (participant-stack.ts). MSK is a *shared* platform resource,
    # so its ARN comes from the platform stack export, not a per-slot one.
    BUCKET=$(cfn_export "workshop-${ID}-shared-bucket")
    MSK_ARN=$(cfn_export "workshop-platform-msk-arn")
    GRAPHQL_ENDPOINT=$(cfn_export "workshop-${ID}-graphql-endpoint")
    CLAIM_SECRET=$(cfn_export "workshop-${ID}-claim-secret")
    MSK_CRED_SECRET=$(cfn_export "workshop-${ID}-msk-cred-secret")
    EKS_CLUSTER=$(cfn_export "workshop-${ID}-eks-cluster")
    PARTICIPANT_ROLE=$(cfn_export "workshop-${ID}-participant-role")

    cat <<SLOT
## \`${ID}\`

**Share with participant:** ${DOCS_BASE_URL}/?did=${ID}&aid=${ACCOUNT}

| Key | Value |
|-----|-------|
| Deployment ID | \`${ID}\` |
| Workshop URL | [${DOCS_BASE_URL}/?did=${ID}&aid=${ACCOUNT}](${DOCS_BASE_URL}/?did=${ID}&aid=${ACCOUNT}) |
| CloudFormation stack | \`${STACK:-—}\` |
| S3 bucket | \`${BUCKET}\` |
| MSK cluster ARN (shared) | \`${MSK_ARN}\` |
| AppSync GraphQL endpoint | \`${GRAPHQL_ENDPOINT}\` |
| Claim cert secret ARN | \`${CLAIM_SECRET}\` |
| MSK SCRAM credential secret ARN | \`${MSK_CRED_SECRET}\` |
| EKS cluster | \`${EKS_CLUSTER}\` |
| Participant role ARN | \`${PARTICIPANT_ROLE}\` |

### Quick commands

\`\`\`bash
# Smoke-test this slot
WORKSHOP_TEST_SLOT=${ID} node scripts/smoke-test.mjs

# Create a participant user
scripts/create-workshop-user.sh ${ID} PARTICIPANT_EMAIL

# Tail EC2 instance logs via SSM
scripts/ssm-run.sh ${ID} "sudo journalctl -u aws-iot-device-client -n 50"

# Tear down this slot when done
scripts/teardown.sh ${ID}
\`\`\`

---

SLOT
  done
} > "$OUT_FILE"

echo ">>> Deployment summary written to $OUT_FILE"
