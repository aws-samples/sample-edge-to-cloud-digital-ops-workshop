#!/usr/bin/env bash
# ssm-run.sh — run a local shell script on one or more EC2 instances via SSM
#
# Usage:
#   ssm-run.sh <instance-id> [<instance-id> ...] -- <script-file-or-inline-cmd>
#   ssm-run.sh --all-edge [-- <script-file-or-inline-cmd>]
#
# Examples:
#   # Run a local script file on one instance
#   ssm-run.sh i-0abc123 -- ./scripts/check-telemetry.sh
#
#   # Run an inline command on all edge instances for ws-slot00
#   DEPLOYMENT_ID=ws-slot00 ssm-run.sh --all-edge -- "systemctl is-active workshop-telemetry"
#
#   # Run a multiline inline script (use single quotes or a file)
#   ssm-run.sh i-0abc123 -- "
#     echo CPU: \$(top -bn1 | grep 'Cpu(s)' | awk '{print \$2}')
#     systemctl is-active workshop-telemetry
#   "
#
# Environment:
#   DEPLOYMENT_ID   required for --all-edge (default: ws-slot00)
#   SSM_WAIT_SECS   seconds to wait for command to complete (default: 30)
#   SSM_REGION      AWS region (default: us-east-1)

set -euo pipefail

DEPLOYMENT_ID="${DEPLOYMENT_ID:-ws-slot00}"
SSM_WAIT_SECS="${SSM_WAIT_SECS:-30}"
REGION="${SSM_REGION:-us-east-1}"

# ── Parse args ────────────────────────────────────────────────────────────────
INSTANCES=()
SCRIPT_ARG=""
ALL_EDGE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all-edge)
      ALL_EDGE=true
      shift
      ;;
    --)
      shift
      SCRIPT_ARG="$*"
      break
      ;;
    i-*)
      INSTANCES+=("$1")
      shift
      ;;
    *)
      # Treat anything else as the script if no -- was given
      SCRIPT_ARG="$*"
      break
      ;;
  esac
done

if $ALL_EDGE; then
  while IFS= read -r inst; do
    [[ -n "$inst" ]] && INSTANCES+=("$inst")
  done < <(
    aws ec2 describe-instances \
      --region "$REGION" \
      --filters "Name=tag:WorkshopDeploymentId,Values=${DEPLOYMENT_ID}" \
                "Name=instance-state-name,Values=running" \
      --query "Reservations[].Instances[].InstanceId" \
      --output text | tr '\t' '\n'
  )
fi

if [[ ${#INSTANCES[@]} -eq 0 ]]; then
  echo "ERROR: no instances specified. Use instance IDs or --all-edge" >&2
  exit 1
fi

if [[ -z "$SCRIPT_ARG" ]]; then
  echo "ERROR: no script specified. Use -- <script-file-or-inline-cmd>" >&2
  exit 1
fi

# ── Build command content ─────────────────────────────────────────────────────
# If SCRIPT_ARG is a file path that exists, read it; otherwise treat as inline
if [[ -f "$SCRIPT_ARG" ]]; then
  COMMANDS=$(cat "$SCRIPT_ARG")
else
  COMMANDS="$SCRIPT_ARG"
fi

# SSM RunShellScript parameters must be written to a temp file to preserve
# newlines and special characters without shell re-interpretation.
PARAMS_FILE=$(mktemp /tmp/ssm-params-XXXXXX.json)
python3 -c "
import json, sys
script = sys.stdin.read()
print(json.dumps({'commands': [script]}))
" <<< "$COMMANDS" > "$PARAMS_FILE"
trap "rm -f $PARAMS_FILE" EXIT

# ── Send command ──────────────────────────────────────────────────────────────
echo "▶ Running on: ${INSTANCES[*]}"
echo ""

CMD_ID=$(aws ssm send-command \
  --region "$REGION" \
  --instance-ids "${INSTANCES[@]}" \
  --document-name "AWS-RunShellScript" \
  --parameters "file://$PARAMS_FILE" \
  --query "Command.CommandId" \
  --output text)

echo "  Command ID: $CMD_ID"
echo "  Waiting up to ${SSM_WAIT_SECS}s..."
echo ""

sleep "$SSM_WAIT_SECS"

# ── Collect results ───────────────────────────────────────────────────────────
FAILED=0
for INST in "${INSTANCES[@]}"; do
  RESULT=$(aws ssm get-command-invocation \
    --region "$REGION" \
    --command-id "$CMD_ID" \
    --instance-id "$INST" \
    --query "{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}" \
    --output json 2>&1)

  STATUS=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['Status'])" 2>/dev/null || echo "UNKNOWN")
  STDOUT=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['Stdout'].rstrip())" 2>/dev/null || echo "")
  STDERR=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['Stderr'].rstrip())" 2>/dev/null || echo "")

  # Status indicator
  if [[ "$STATUS" == "Success" ]]; then
    ICON="✓"
  else
    ICON="✗"
    FAILED=$((FAILED + 1))
  fi

  echo "━━━ $ICON  $INST  [$STATUS] ━━━"
  [[ -n "$STDOUT" ]] && echo "$STDOUT"
  [[ -n "$STDERR" ]] && echo "--- stderr ---" && echo "$STDERR"
  echo ""
done

[[ $FAILED -gt 0 ]] && exit 1 || exit 0
