#!/bin/bash
# Create a Cognito user for workshop login.
# Usage: ./scripts/create-workshop-user.sh --deployment-id ws-slot00 [--username <email>] [--password <pass>]
#
# If --password is omitted, a strong random password is generated and printed —
# there is no hardcoded default, so it can't be guessed or reused across slots.
set -euo pipefail

DEPLOYMENT_ID=""
USERNAME=""
PASSWORD=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --deployment-id) DEPLOYMENT_ID="$2"; shift 2 ;;
    --username)      USERNAME="$2"; shift 2 ;;
    --password)      PASSWORD="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [ -z "$DEPLOYMENT_ID" ]; then
  echo "Usage: $0 --deployment-id <ws-slotNN> [--username <email>] [--password <pass>]"
  echo ""
  echo "  --deployment-id  Required. Workshop slot, e.g. ws-slot00."
  echo "  --username       Optional. Defaults to participant@<deployment-id>.workshop.local."
  echo "  --password       Optional. Defaults to a generated strong random password"
  echo "                   (Cognito policy: min 8 chars, upper/lower/number/symbol)."
  exit 1
fi

# Generate a strong random password when none is supplied: an "Aa1!" prefix
# guarantees upper/lower/number/symbol classes, plus 14 random alphanumerics
# to satisfy the Cognito pool's password policy without needing to know it.
if [ -z "$PASSWORD" ]; then
  PASSWORD="Aa1!$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 14)"
fi

# Slug used in Amplify sandbox stack names: ws-slot11 → wsslot11
# Discover the Cognito User Pool ID. Primary source is the SSM parameter that
# auth-stack.ts publishes for the slot (epic #181 — the slot's auth resources are
# now a plain-CDK AuthNestedStack, not an Amplify sandbox backend).
USER_POOL_ID=$(aws ssm get-parameter --name "/workshop/${DEPLOYMENT_ID}/user-pool-id" \
  --query "Parameter.Value" --output text 2>/dev/null || true)

# Fall back: search Cognito directly by the pool name auth-stack.ts assigns,
# `workshop-<deployment-id>` (e.g. workshop-ws-slot00).
if [ -z "$USER_POOL_ID" ] || [ "$USER_POOL_ID" = "None" ]; then
  USER_POOL_ID=$(aws cognito-idp list-user-pools --max-results 60 \
    --query "UserPools[?Name=='workshop-${DEPLOYMENT_ID}'].Id | [0]" --output text 2>/dev/null || true)
fi

if [ -z "$USER_POOL_ID" ] || [ "$USER_POOL_ID" = "None" ]; then
  echo "ERROR: Could not locate the Cognito User Pool for ${DEPLOYMENT_ID}."
  echo "  Deploy the slot first ('pnpm run sandbox ${DEPLOYMENT_ID}'), then try again."
  exit 1
fi

USERNAME="${USERNAME:-participant@${DEPLOYMENT_ID}.workshop.local}"

aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$USERNAME" \
  --temporary-password "$PASSWORD" \
  --user-attributes Name=email,Value="$USERNAME" Name=email_verified,Value=true \
  --message-action SUPPRESS > /dev/null 2>&1 || true

aws cognito-idp admin-set-user-password \
  --user-pool-id "$USER_POOL_ID" \
  --username "$USERNAME" \
  --password "$PASSWORD" \
  --permanent

echo ""
echo "Workshop login credentials:"
echo "  Username : $USERNAME"
echo "  Password : $PASSWORD"
echo ""
echo "Cloud analytics dashboard (Session 04) — port-forward, no public URL:"
echo "  kubectl port-forward -n ${DEPLOYMENT_ID} svc/cloud-analytics-dashboard 3000:3000"
echo "  then open http://localhost:3000"
echo ""
