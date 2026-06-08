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

# Discover the Cognito User Pool ID from CloudFormation outputs
USER_POOL_ID=$(aws cloudformation describe-stacks \
  --query "Stacks[?StackName].Outputs[?OutputKey=='AuthUserPoolId'].OutputValue | [0]" \
  --output text 2>/dev/null || true)

if [ -z "$USER_POOL_ID" ] || [ "$USER_POOL_ID" = "None" ]; then
  echo "Searching for User Pool by name…"
  USER_POOL_ID=$(aws cognito-idp list-user-pools --max-results 60 \
    --query "UserPools[?contains(Name,'workshop')].Id | [0]" --output text)
fi

if [ -z "$USER_POOL_ID" ] || [ "$USER_POOL_ID" = "None" ]; then
  echo "ERROR: Could not locate the workshop Cognito User Pool."
  echo "  Run 'npx ampx sandbox' first, then try again."
  exit 1
fi

USERNAME="${USERNAME:-participant@${DEPLOYMENT_ID}.workshop.local}"

echo "Creating user: $USERNAME in pool: $USER_POOL_ID"

aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$USERNAME" \
  --temporary-password "$TEMP_PASSWORD" \
  --user-attributes Name=email,Value="$USERNAME" Name=email_verified,Value=true \
  --message-action SUPPRESS 2>/dev/null || echo "User may already exist — skipping create"

aws cognito-idp admin-set-user-password \
  --user-pool-id "$USER_POOL_ID" \
  --username "$USERNAME" \
  --password "$TEMP_PASSWORD" \
  --permanent

echo ""
echo "✓ User created:"
echo "  Username : $USERNAME"
echo "  Password : $TEMP_PASSWORD"
echo ""
echo "Load the Amplify-hosted URL and sign in with these credentials."
