#!/usr/bin/env bash
# #248 round-6 regression check: the IoT-Job write-verification guard in
# telemetry-v1.sh must not match its own explanatory comment ("...aws
# iot-data publish...") as if it were the live per-message loop. A bare
# substring `grep -q "aws iot-data publish"` did exactly that, false-aborting
# a successful job even though the old loop had already been replaced with
# the coproc/mqtt-publisher.py path -- see #248's round-5/round-6 history.
# This is a static text check, not a live-deploy test: it exists to catch a
# future edit that de-anchors the guard regex again.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$SCRIPT_DIR/../job-scripts/telemetry-v1.sh"

GUARD_REGEX=$(grep -oE "grep -qE '\^[^']+'" "$TARGET" | head -1 | sed -E "s/^grep -qE '(.*)'\$/\1/")
if [[ -z "$GUARD_REGEX" ]]; then
  echo "ERROR: $TARGET: could not locate the anchored write-verification guard regex (grep -qE '^...') -- update this check if the guard was intentionally rewritten." >&2
  exit 1
fi

STATUS=0

if echo '# this comment mentions aws iot-data publish for context' | grep -qE "$GUARD_REGEX"; then
  echo "ERROR: guard regex '$GUARD_REGEX' matches a comment line -- reintroduces #248's false-positive job failure." >&2
  STATUS=1
else
  echo "OK: guard regex '$GUARD_REGEX' does not match a comment referencing the old command."
fi

if echo 'aws iot-data publish --topic foo --payload bar' | grep -qE "$GUARD_REGEX"; then
  echo "OK: guard regex '$GUARD_REGEX' still catches a real per-message publish command."
else
  echo "ERROR: guard regex '$GUARD_REGEX' fails to catch a real per-message publish command -- the guard would no longer detect a stuck-on-old-path device." >&2
  STATUS=1
fi

exit "$STATUS"
