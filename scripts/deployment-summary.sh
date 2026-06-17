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

# ── Helper: read one CloudFormation export value ─────────────────────────────
cfn_export() {
  aws cloudformation list-exports \
    --query "Exports[?Name=='$1'].Value | [0]" \
    --output text 2>/dev/null || echo "—"
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

Each **Deployment ID** is the unique identifier for one participant slot.  Use it to:

| Task | Command |
|------|---------|
| Run smoke tests | \`WORKSHOP_TEST_SLOT=<id> node scripts/smoke-test.mjs\` |
| Create a participant user | \`scripts/create-workshop-user.sh <id> email@example.com\` |
| Tear down a single slot | \`scripts/teardown.sh <id>\` |
| View stack outputs in AWS Console | CloudFormation → stack \`amplify-edgedigitalopsworkshop-<id>-*\` → Outputs tab |

---

HEADER

  for ID in "${DEPLOYMENT_IDS[@]}"; do
    # Stack name pattern used by Amplify Gen 2
    STACK=$(aws cloudformation describe-stacks \
      --query "Stacks[?contains(StackName, '${ID}')].StackName | [0]" \
      --output text 2>/dev/null || echo "")

    BUCKET=$(cfn_export "workshop-${ID}-bucket")
    MSK_ARN=$(cfn_export "workshop-${ID}-msk-arn")
    EVENTS_HTTP=$(cfn_export "workshop-${ID}-events-http")
    EVENTS_RT=$(cfn_export "workshop-${ID}-events-realtime")
    CLAIM_SECRET=$(cfn_export "workshop-${ID}-claim-secret")
    MSK_CRED_SECRET=$(cfn_export "workshop-${ID}-msk-cred-secret")
    EKS_CLUSTER=$(cfn_export "workshop-${ID}-eks-cluster")

    cat <<SLOT
## \`${ID}\`

| Key | Value |
|-----|-------|
| Deployment ID | \`${ID}\` |
| CloudFormation stack | \`${STACK:-—}\` |
| S3 bucket | \`${BUCKET}\` |
| MSK cluster ARN | \`${MSK_ARN}\` |
| AppSync Events HTTP endpoint | \`${EVENTS_HTTP}\` |
| AppSync Events Realtime endpoint | \`${EVENTS_RT}\` |
| Claim cert secret ARN | \`${CLAIM_SECRET}\` |
| MSK SCRAM credential secret ARN | \`${MSK_CRED_SECRET}\` |
| EKS cluster | \`${EKS_CLUSTER}\` |

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
