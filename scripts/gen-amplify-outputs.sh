#!/usr/bin/env bash
# gen-amplify-outputs.sh — reconstruct frontend/amplify_outputs.json for a slot.
#
# Usage: scripts/gen-amplify-outputs.sh <ws-slotNN> [--out <path>]
#
# WHY THIS EXISTS (epic #180 / #181):
# The Amplify Gen 2 CLI (`ampx sandbox`) used to emit amplify_outputs.json, which
# frontend/src/app/layout.tsx loads to configure `Amplify.configure(...)`. We
# replaced the ampx-owned auth/data lifecycle with plain-CDK nested stacks
# (auth-stack.ts / data-stack.ts), so nothing generates that file anymore. Those
# stacks instead publish their outputs to SSM per slot:
#   /workshop/<id>/user-pool-id
#   /workshop/<id>/user-pool-client-id
#   /workshop/<id>/identity-pool-id
#   /workshop/<id>/graphql-endpoint
# This script reads them and writes an amplify_outputs.json in the shape
# aws-amplify v6 expects, so the frontend configures identically to before.

set -euo pipefail

DEPLOYMENT_ID=""
OUT="frontend/amplify_outputs.json"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    *)     DEPLOYMENT_ID="$1"; shift ;;
  esac
done

if [[ -z "$DEPLOYMENT_ID" ]]; then
  echo "Usage: $0 <ws-slotNN> [--out <path>]" >&2
  exit 1
fi

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region || echo us-east-1)}}"

get_param() {
  aws ssm get-parameter --name "$1" --region "$REGION" \
    --query "Parameter.Value" --output text 2>/dev/null || echo ""
}

USER_POOL_ID=$(get_param "/workshop/${DEPLOYMENT_ID}/user-pool-id")
USER_POOL_CLIENT_ID=$(get_param "/workshop/${DEPLOYMENT_ID}/user-pool-client-id")
IDENTITY_POOL_ID=$(get_param "/workshop/${DEPLOYMENT_ID}/identity-pool-id")
GRAPHQL_URL=$(get_param "/workshop/${DEPLOYMENT_ID}/graphql-endpoint")

for pair in \
  "user-pool-id=$USER_POOL_ID" \
  "user-pool-client-id=$USER_POOL_CLIENT_ID" \
  "identity-pool-id=$IDENTITY_POOL_ID" \
  "graphql-endpoint=$GRAPHQL_URL"; do
  name="${pair%%=*}"; val="${pair#*=}"
  if [[ -z "$val" || "$val" == "None" ]]; then
    echo "ERROR: /workshop/${DEPLOYMENT_ID}/${name} is not set — is the slot deployed?" >&2
    exit 1
  fi
done

# aws-amplify v6 amplify_outputs.json shape (auth + data). The data API uses IAM
# auth (see data-stack.ts); user-pool auth backs the Authenticator UI.
python3 - "$OUT" "$REGION" "$USER_POOL_ID" "$USER_POOL_CLIENT_ID" "$IDENTITY_POOL_ID" "$GRAPHQL_URL" <<'PY'
import json, sys, os
out, region, pool, client, identity, url = sys.argv[1:7]
cfg = {
    "version": "1.3",
    "auth": {
        "aws_region": region,
        "user_pool_id": pool,
        "user_pool_client_id": client,
        "identity_pool_id": identity,
        "username_attributes": ["email"],
        "standard_required_attributes": ["email"],
        "user_verification_types": ["email"],
        "unauthenticated_identities_enabled": False,
    },
    "data": {
        "aws_region": region,
        "url": url,
        "default_authorization_type": "AWS_IAM",
        "authorization_types": ["AWS_IAM"],
    },
}
os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
with open(out, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
print(f">>> Wrote {out} for {pool} / {url}")
PY
