#!/bin/bash
# Create a Cognito user for workshop login.
# Usage: ./scripts/create-workshop-user.sh --deployment-id ws-slot00
set -euo pipefail

DEPLOYMENT_ID=""
USERNAME=""
TEMP_PASSWORD="Workshop1234!"

while [[ $# -gt 0 ]]; do
  case $1 in
    --deployment-id) DEPLOYMENT_ID="$2"; shift 2 ;;
    --username)      USERNAME="$2"; shift 2 ;;
    --password)      TEMP_PASSWORD="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [ -z "$DEPLOYMENT_ID" ]; then
  echo "Usage: $0 --deployment-id <ws-slotNN> [--username <email>] [--password <pass>]"
  exit 1
fi

# Slug used in Amplify sandbox stack names: ws-slot11 → wsslot11
DEPLOYMENT_SLUG="${DEPLOYMENT_ID//-/}"

# Discover the Cognito User Pool ID from the root Amplify sandbox stack.
# The root stack name matches the pattern: amplify-edgedigitalopsworkshop-{slug}-sandbox-{10-hex-hash}
# Sub-stacks append further suffixes (-dataXXX, -authXXX, etc.) so we match the root exactly.
ROOT_STACK=$(aws cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query "StackSummaries[?contains(StackName,'amplify-edgedigitalopsworkshop-${DEPLOYMENT_SLUG}-sandbox')].StackName" \
  --output text 2>/dev/null \
  | tr '\t' '\n' \
  | grep -E "^amplify-edgedigitalopsworkshop-${DEPLOYMENT_SLUG}-sandbox-[0-9a-f]{10}$" \
  | head -1 || true)

USER_POOL_ID=""
if [ -n "$ROOT_STACK" ]; then
  USER_POOL_ID=$(aws cloudformation describe-stacks \
    --stack-name "$ROOT_STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='userPoolId'].OutputValue | [0]" \
    --output text 2>/dev/null || true)
fi

# Fall back: search Cognito directly by pool name containing the slug.
if [ -z "$USER_POOL_ID" ] || [ "$USER_POOL_ID" = "None" ]; then
  USER_POOL_ID=$(aws cognito-idp list-user-pools --max-results 60 \
    --query "UserPools[?contains(Name,'${DEPLOYMENT_SLUG}')].Id | [0]" --output text 2>/dev/null || true)
fi

if [ -z "$USER_POOL_ID" ] || [ "$USER_POOL_ID" = "None" ]; then
  echo "ERROR: Could not locate the Cognito User Pool for ${DEPLOYMENT_ID}."
  echo "  Run 'npx ampx sandbox --identifier ${DEPLOYMENT_ID}' first, then try again."
  exit 1
fi

USERNAME="${USERNAME:-participant@${DEPLOYMENT_ID}.workshop.local}"

aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$USERNAME" \
  --temporary-password "$TEMP_PASSWORD" \
  --user-attributes Name=email,Value="$USERNAME" Name=email_verified,Value=true \
  --message-action SUPPRESS > /dev/null 2>&1 || true

aws cognito-idp admin-set-user-password \
  --user-pool-id "$USER_POOL_ID" \
  --username "$USERNAME" \
  --password "$TEMP_PASSWORD" \
  --permanent

echo ""
echo "Workshop login credentials:"
echo "  Username : $USERNAME"
echo "  Password : $TEMP_PASSWORD"
echo ""
echo "Cloud analytics dashboard (Session 04) — port-forward, no public URL:"
echo "  kubectl port-forward -n ${DEPLOYMENT_ID} svc/cloud-analytics-dashboard 3000:3000"
echo "  then open http://localhost:3000"
echo ""
