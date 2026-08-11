#!/usr/bin/env bash
# trigger-deploy.sh — fire-and-forget: kick off a cloud deploy and return a
# pollable handle immediately (epic #180 / #182 / #183).
#
# Usage:
#   scripts/trigger-deploy.sh <ws-slotNN> [ws-slotNN ...] [--branch <ref>]
#
# Starts the `workshop-deploy-orchestrator` CodeBuild project (see
# amplify/custom/orchestrator-stack.ts) for the given slot set and prints the
# build id — the handle — then EXITS. It does NOT wait for the 20-40 min deploy.
# Poll it with scripts/poll-deploy.sh <build-id>.
#
# The orchestrator project must already be deployed once per account:
#   npx cdk deploy --app "npx tsx amplify/custom/orchestrator-app.ts" \
#     WorkshopDeployOrchestrator -c repoCloneUrl=<https url>

set -euo pipefail

PROJECT="${ORCHESTRATOR_PROJECT:-workshop-deploy-orchestrator}"
BRANCH=""
SLOTS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch) BRANCH="$2"; shift 2 ;;
    *)        SLOTS+=("$1"); shift ;;
  esac
done

if [[ ${#SLOTS[@]} -eq 0 ]]; then
  echo "Usage: $0 <ws-slotNN> [ws-slotNN ...] [--branch <ref>]" >&2
  exit 1
fi

# Join slots with commas for the WORKSHOP_SLOTS env override.
SLOT_CSV=$(IFS=,; echo "${SLOTS[*]}")

START_ARGS=(
  --project-name "$PROJECT"
  --environment-variables-override "name=WORKSHOP_SLOTS,value=${SLOT_CSV},type=PLAINTEXT"
)
[[ -n "$BRANCH" ]] && START_ARGS+=(--source-version "$BRANCH")

echo ">>> Starting async deploy of slots: $SLOT_CSV (project: $PROJECT${BRANCH:+, branch: $BRANCH})" >&2
BUILD_ID=$(aws codebuild start-build "${START_ARGS[@]}" \
  --query 'build.id' --output text)

echo ">>> Build started. Handle (build id): $BUILD_ID" >&2
echo ">>> Poll with: scripts/poll-deploy.sh $BUILD_ID" >&2
# Emit the bare build id on stdout so callers (CI) can capture it.
echo "$BUILD_ID"
