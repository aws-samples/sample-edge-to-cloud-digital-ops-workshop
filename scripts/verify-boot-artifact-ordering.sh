#!/usr/bin/env bash
# #248 self-check: assert boot-time S3 artifacts (device-client binary,
# mqtt-publisher.py, simulators) are staged to S3 *before* the `cdk deploy`
# that boots edge instances, in the common bucket-already-exists path.
#
# #248's root cause was exactly this ordering inverted: sandbox.sh/
# sandbox-all.sh uploaded mqtt-publisher.py AFTER `cdk deploy`, so freshly
# launched instances' boot-time `aws s3 cp` raced the upload and 404'd,
# silently skipping the persistent MQTT publisher install. This is a static
# text check, not a live-deploy test -- it exists to catch a future edit that
# reintroduces the same ordering bug, not to validate AWS behavior.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

check_file() {
  local file="$1"
  local deploy_line upload_line
  deploy_line=$(grep -n 'npx cdk deploy' "$file" | head -1 | cut -d: -f1)
  upload_line=$(grep -n 'upload_boot_artifacts "\$S3_BUCKET"' "$file" | head -1 | cut -d: -f1)
  if [[ -z "$deploy_line" || -z "$upload_line" ]]; then
    echo "ERROR: $file: could not locate 'npx cdk deploy' and/or the first 'upload_boot_artifacts \"\$S3_BUCKET\"' call -- update this check if either was intentionally renamed." >&2
    return 1
  fi
  if [[ "$upload_line" -ge "$deploy_line" ]]; then
    echo "ERROR: $file: boot-time artifact upload (line $upload_line) does not precede cdk deploy (line $deploy_line) -- this reintroduces #248's S3-upload/instance-boot race." >&2
    return 1
  fi
  echo "OK: $file stages boot-time artifacts (line $upload_line) before cdk deploy (line $deploy_line)."
}

STATUS=0
check_file "$SCRIPT_DIR/sandbox.sh" || STATUS=1
check_file "$SCRIPT_DIR/sandbox-all.sh" || STATUS=1
exit "$STATUS"
