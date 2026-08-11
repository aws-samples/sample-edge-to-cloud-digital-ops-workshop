#!/usr/bin/env bash
# poll-deploy.sh — poll a fire-and-forget deploy handle to completion (epic
# #180 / #182). The handle is a CodeBuild build id from scripts/trigger-deploy.sh.
#
# Usage:
#   scripts/poll-deploy.sh <build-id> [--interval 60] [--timeout 7200] [--once]
#
#   --once      print the current status and exit 0 (don't loop) — for CI job
#               summaries or the laptop monitor pattern in CLAUDE.md.
#   --interval  poll seconds (default 60)
#   --timeout   give up after N seconds (default 7200 = 2 h)
#
# Exit code: 0 if the build SUCCEEDED, non-zero otherwise (FAILED / FAULT /
# TIMED_OUT / STOPPED, or the poll timed out). With --once, exit 0 regardless
# (status is on stdout).

set -euo pipefail

BUILD_ID=""
INTERVAL=60
TIMEOUT=7200
ONCE=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval) INTERVAL="$2"; shift 2 ;;
    --timeout)  TIMEOUT="$2"; shift 2 ;;
    --once)     ONCE=true; shift ;;
    *)          BUILD_ID="$1"; shift ;;
  esac
done

if [[ -z "$BUILD_ID" ]]; then
  echo "Usage: $0 <build-id> [--interval N] [--timeout N] [--once]" >&2
  exit 1
fi

status_of() {
  aws codebuild batch-get-builds --ids "$1" \
    --query 'builds[0].buildStatus' --output text 2>/dev/null || echo "UNKNOWN"
}

if $ONCE; then
  status_of "$BUILD_ID"
  exit 0
fi

start=$SECONDS
while :; do
  STATUS=$(status_of "$BUILD_ID")
  echo "$(date -u +%FT%TZ)  $BUILD_ID  $STATUS"
  case "$STATUS" in
    SUCCEEDED)                       echo "RESULT=SUCCEEDED"; exit 0 ;;
    FAILED|FAULT|TIMED_OUT|STOPPED)  echo "RESULT=$STATUS"; exit 1 ;;
  esac
  if (( SECONDS - start >= TIMEOUT )); then
    echo "RESULT=POLL_TIMEOUT (last status: $STATUS)"; exit 1
  fi
  sleep "$INTERVAL"
done
