#!/usr/bin/env bash
set -euo pipefail
STACK_NAME="$1"
export ORPHAN_STACK_NAME="$STACK_NAME"
npx cdk destroy \
  --app "npx tsx amplify/custom/orphan-stack-app.ts" \
  --force \
  OrphanStack
