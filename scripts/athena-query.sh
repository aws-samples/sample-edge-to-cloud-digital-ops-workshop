#!/usr/bin/env bash
# Run an Athena SQL query and print results as a table.
# Usage:
#   ./scripts/athena-query.sh "SELECT COUNT(*) FROM workshop_telemetry.telemetry"
#   ./scripts/athena-query.sh -f my-query.sql
#   echo "SELECT 1" | ./scripts/athena-query.sh

set -euo pipefail

WORKGROUP="${ATHENA_WORKGROUP:-workshop-shared}"
POLL_INTERVAL=2
TIMEOUT=120

# Read SQL from -f <file>, first positional arg, or stdin
if [[ "${1:-}" == "-f" ]]; then
  SQL=$(cat "$2")
elif [[ -n "${1:-}" ]]; then
  SQL="$1"
else
  SQL=$(cat)
fi

if [[ -z "${SQL:-}" ]]; then
  echo "Usage: $0 \"SELECT ...\" | -f file.sql" >&2
  exit 1
fi

# Start query
QUERY_ID=$(aws athena start-query-execution \
  --query-string "$SQL" \
  --work-group "$WORKGROUP" \
  --query 'QueryExecutionId' --output text)

echo "QueryId: $QUERY_ID" >&2

# Poll until done
elapsed=0
while true; do
  STATE=$(aws athena get-query-execution \
    --query-execution-id "$QUERY_ID" \
    --query 'QueryExecution.Status.State' --output text)
  if [[ "$STATE" == "SUCCEEDED" ]]; then break; fi
  if [[ "$STATE" == "FAILED" || "$STATE" == "CANCELLED" ]]; then
    REASON=$(aws athena get-query-execution \
      --query-execution-id "$QUERY_ID" \
      --query 'QueryExecution.Status.StateChangeReason' --output text)
    echo "Query $STATE: $REASON" >&2
    exit 1
  fi
  sleep "$POLL_INTERVAL"
  elapsed=$((elapsed + POLL_INTERVAL))
  if [[ $elapsed -ge $TIMEOUT ]]; then
    echo "Timed out after ${TIMEOUT}s (state: $STATE)" >&2
    exit 1
  fi
done

# Fetch results and format as a table
JSON=$(aws athena get-query-results \
  --query-execution-id "$QUERY_ID" \
  --query 'ResultSet.Rows' \
  --output json)

python3 -c "
import sys, json

raw = json.loads(sys.argv[1])
if not raw:
    print('(no results)')
    sys.exit(0)

rows = [[cell.get('VarCharValue', 'NULL') for cell in r['Data']] for r in raw]
ncols = max(len(r) for r in rows)
rows = [r + [''] * (ncols - len(r)) for r in rows]
widths = [max(len(rows[r][c]) for r in range(len(rows))) for c in range(ncols)]
sep = '+-' + '-+-'.join('-' * w for w in widths) + '-+'
fmt = '| ' + ' | '.join('{:<' + str(w) + '}' for w in widths) + ' |'
print(sep)
print(fmt.format(*rows[0]))
print(sep)
for row in rows[1:]:
    print(fmt.format(*row))
print(sep)
print(f'({len(rows)-1} rows)', file=sys.stderr)
" "$JSON"
