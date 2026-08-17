#!/bin/bash
# --8<-- [start:job-handler]
# IoT Job handler: shadow-driven telemetry config (integer-precision metrics).
# Reads desired.telemetry_interval_ms and desired.metrics from the device-config
# shadow on startup; falls back to 100 ms / all five metrics if no desired state is set.
# Exit 0 = SUCCESS reported to IoT Jobs; non-zero = FAILED.
set -euo pipefail

_TOKEN=$(curl -s -X PUT --max-time 5 http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null || true)
for _i in $(seq 1 15); do
  INSTANCE_ID=$(curl -s --max-time 2 ${_TOKEN:+-H "X-aws-ec2-metadata-token: $_TOKEN"} http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null)
  [ -n "$INSTANCE_ID" ] && break
  sleep 3
done
REGION=$(curl -s --max-time 5 ${_TOKEN:+-H "X-aws-ec2-metadata-token: $_TOKEN"} http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || echo "us-east-1")
IOT_ENDPOINT=$(aws iot describe-endpoint --region "$REGION" --endpoint-type iot:Data-ATS --query endpointAddress --output text)

TELEMETRY_SCRIPT=/etc/aws-iot-device-client/jobs/publish-telemetry.sh

# Ensure jq is available for shadow JSON parsing
command -v jq >/dev/null 2>&1 || yum install -y jq || dnf install -y jq

# Ensure the persistent MQTT publisher + its SDK are present (#248). Boot-time
# UserData installs these on a device's first boot, but this job handler must
# not depend on that having succeeded -- install them here too if missing, so
# re-pushing this job (scripts/push-telemetry-job.sh) is self-sufficient
# regardless of what any individual device's UserData run did or didn't do.
# Round 3 (#248): retry + fail loud instead of one unguarded attempt -- a
# transient pip/S3 hiccup here must not leave the fleet silently stuck on the
# old aws iot-data publish path behind a false-COMPLETED job.
# Round 4 (#248): awsiotsdk pins awscrt==0.36.1, but the device already has
# awscrt 0.31.1 installed system-wide via rpm -- pip then tries to uninstall
# the rpm-managed package and fails every retry ("installed by rpm"). Isolate
# the install in a dedicated venv so pip never touches the system awscrt.
if [[ ! -x /opt/mqtt-venv/bin/python3 ]]; then
  python3 -m ensurepip --upgrade >/dev/null 2>&1 || true
  python3 -m venv /opt/mqtt-venv
fi
if ! /opt/mqtt-venv/bin/python3 -c "import awsiot" >/dev/null 2>&1; then
  /opt/mqtt-venv/bin/pip install --upgrade pip >/dev/null 2>&1 || true
  SDK_INSTALLED=0
  for _attempt in 1 2 3 4 5; do
    /opt/mqtt-venv/bin/pip install awsiotsdk && { SDK_INSTALLED=1; break; }
    echo "WARN: /opt/mqtt-venv/bin/pip install awsiotsdk failed (attempt $_attempt/5) -- retrying in 5s" >&2
    sleep 5
  done
  [[ "$SDK_INSTALLED" -eq 1 ]] || { echo "ERROR: /opt/mqtt-venv/bin/pip install awsiotsdk failed after 5 attempts -- aborting job" >&2; exit 1; }
fi
if [[ ! -x /usr/local/bin/mqtt-publisher.py ]]; then
  MQTT_PUB_BUCKET=$(aws cloudformation list-exports --region "$REGION" --query "Exports[?Name=='workshop-platform-bucket-name'].Value" --output text)
  MQTT_PUB_FETCHED=0
  for _attempt in 1 2 3 4 5; do
    aws s3 cp "s3://${MQTT_PUB_BUCKET}/bin/mqtt-publisher.py" /usr/local/bin/mqtt-publisher.py --region "$REGION" && { MQTT_PUB_FETCHED=1; break; }
    echo "WARN: aws s3 cp mqtt-publisher.py failed (attempt $_attempt/5) -- retrying in 5s" >&2
    sleep 5
  done
  [[ "$MQTT_PUB_FETCHED" -eq 1 ]] || { echo "ERROR: aws s3 cp mqtt-publisher.py failed after 5 attempts -- aborting job" >&2; exit 1; }
  chmod +x /usr/local/bin/mqtt-publisher.py
fi

# ── Read desired config from shadow (job handler scope) ───────────────────────
# We read it here so we can echo the actual applied values back in the reported shadow.
SHADOW_TMP=$(mktemp)
aws iot-data get-thing-shadow \
  --region "$REGION" \
  --endpoint-url "https://$IOT_ENDPOINT" \
  --thing-name "$INSTANCE_ID" \
  --shadow-name device-config \
  --cli-binary-format raw-in-base64-out \
  "$SHADOW_TMP" 2>/dev/null || echo '{}' > "$SHADOW_TMP"
DESIRED_INTERVAL_MS=$(jq -r '.state.desired.telemetry_interval_ms // 100' "$SHADOW_TMP")
DESIRED_METRICS=$(jq -c '.state.desired.metrics // ["cpu_pct","mem_used_pct","disk_used_pct","net_io_bytes_sent","net_io_bytes_recv"]' "$SHADOW_TMP")
rm -f "$SHADOW_TMP"

# ── Write updated telemetry script ────────────────────────────────────────────
cat > "$TELEMETRY_SCRIPT" <<'TELEMETRY'
#!/bin/bash
_TOKEN=$(curl -s -X PUT --max-time 5 http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null || true)
for _i in $(seq 1 15); do
  INSTANCE_ID=$(curl -s --max-time 2 ${_TOKEN:+-H "X-aws-ec2-metadata-token: $_TOKEN"} http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null)
  [ -n "$INSTANCE_ID" ] && break
  sleep 3
done
DEPLOYMENT_ID="${DEPLOYMENT_ID:-ws-slot00}"
REGION=$(curl -s --max-time 5 ${_TOKEN:+-H "X-aws-ec2-metadata-token: $_TOKEN"} http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || echo "us-east-1")
IOT_ENDPOINT=$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text)

# Read desired config from device-config shadow; fall back to safe defaults
SHADOW_FILE=$(mktemp)
aws iot-data get-thing-shadow \
  --region "$REGION" \
  --endpoint-url "https://$IOT_ENDPOINT" \
  --thing-name "$INSTANCE_ID" \
  --shadow-name device-config \
  --cli-binary-format raw-in-base64-out \
  "$SHADOW_FILE" 2>/dev/null || echo '{}' > "$SHADOW_FILE"

INTERVAL_MS=$(jq -r '.state.desired.telemetry_interval_ms // 100' "$SHADOW_FILE")
METRICS=$(jq -c '.state.desired.metrics // ["cpu_pct","mem_used_pct","disk_used_pct","net_io_bytes_sent","net_io_bytes_recv"]' "$SHADOW_FILE")
rm -f "$SHADOW_FILE"

SLEEP_S=$(awk "BEGIN {printf \"%.3f\", $INTERVAL_MS / 1000}")

PREV_SENT=0
PREV_RECV=0

# #244: one persistent MQTT connection for the life of this process, instead
# of a new `aws iot-data publish` process (+ fresh TLS handshake) per message.
# The client id must differ from the device's own Thing name -- AWS IoT drops
# the OLDER connection on a client-id collision, which would kick the device
# client's Jobs/shadow session offline every time this loop restarts.
coproc MQTT_PUB { /opt/mqtt-venv/bin/python3 /usr/local/bin/mqtt-publisher.py \
  --endpoint "$IOT_ENDPOINT" \
  --region "$REGION" \
  --topic "edge/$DEPLOYMENT_ID/$INSTANCE_ID/telemetry" \
  --client-id "${INSTANCE_ID}-telemetry-pub"; }

while true; do
  # Collect measurements; top -bn1 takes ~100ms to sample CPU
  CPU=$(top -bn1 | grep "Cpu(s)" | awk '{printf "%d", $2+0}')
  MEM=$(free | awk '/Mem:/ {printf "%d", $3/$2*100}')
  DISK=$(df / | awk 'NR==2 {printf "%d", $5+0}')

  # Network I/O delta
  NET_LINE=$(grep -E 'eth0|ens5' /proc/net/dev | head -1)
  NET_RECV=$(echo "$NET_LINE" | awk '{print $2}')
  NET_SENT=$(echo "$NET_LINE" | awk '{print $10}')
  NET_IO_RECV=$((NET_RECV - PREV_RECV))
  NET_IO_SENT=$((NET_SENT - PREV_SENT))
  PREV_RECV=$NET_RECV
  PREV_SENT=$NET_SENT

  # Stamp timestamp immediately before publish
  TS=$(date -u +%s%3N)

  # Build payload with only the metrics listed in the shadow desired config
  METRICS_FIELDS=""
  for METRIC in $(echo "$METRICS" | jq -r '.[]'); do
    case "$METRIC" in
      cpu_pct)            METRICS_FIELDS="${METRICS_FIELDS},\"cpu_pct\":${CPU}" ;;
      mem_used_pct)       METRICS_FIELDS="${METRICS_FIELDS},\"mem_used_pct\":${MEM}" ;;
      disk_used_pct)      METRICS_FIELDS="${METRICS_FIELDS},\"disk_used_pct\":${DISK}" ;;
      net_io_bytes_sent)  METRICS_FIELDS="${METRICS_FIELDS},\"net_io_bytes_sent\":${NET_IO_SENT}" ;;
      net_io_bytes_recv)  METRICS_FIELDS="${METRICS_FIELDS},\"net_io_bytes_recv\":${NET_IO_RECV}" ;;
    esac
  done
  PAYLOAD="{\"thing_name\":\"${INSTANCE_ID}\",\"message_timestamp\":${TS}${METRICS_FIELDS}}"

  echo "$PAYLOAD" >&"${MQTT_PUB[1]}" || true

  sleep "$SLEEP_S"
done
TELEMETRY

chmod +x "$TELEMETRY_SCRIPT"

# ── Restart telemetry service ──────────────────────────────────────────────────
# Round 3 (#248): the write above only lands on disk -- the continuously-running
# workshop-telemetry.service (ExecStart=$TELEMETRY_SCRIPT) does not pick it up
# until restarted, and a restart that doesn't actually come back active leaves
# the fleet on the OLD publisher with no signal beyond a false-COMPLETED job.
# Fail loud on both checks so that failure surfaces on the IoT Job itself.
# Anchor to a real command invocation (leading whitespace + the command), not
# the string anywhere in the file -- the written script's own explanatory
# comment references `aws iot-data publish`, which a bare substring grep would
# match and false-abort even though the old loop is gone (#248).
grep -qE '^[[:space:]]*aws iot-data publish' "$TELEMETRY_SCRIPT" && { echo "ERROR: $TELEMETRY_SCRIPT still contains the old per-message publish loop after write" >&2; exit 1; }
/opt/mqtt-venv/bin/python3 -c "import awsiot" || { echo "ERROR: /opt/mqtt-venv/bin/python3 cannot import awsiot -- aborting job before restart" >&2; exit 1; }
systemctl restart workshop-telemetry
TELEMETRY_ACTIVE=0
for _attempt in 1 2 3 4 5; do
  sleep 2
  systemctl is-active --quiet workshop-telemetry && { TELEMETRY_ACTIVE=1; break; }
  echo "WARN: workshop-telemetry not active yet after restart (attempt $_attempt/5)" >&2
done
if [[ "$TELEMETRY_ACTIVE" -ne 1 ]]; then
  echo "ERROR: workshop-telemetry failed to become active after restart" >&2
  systemctl status workshop-telemetry --no-pager >&2 || true
  exit 1
fi

# ── Update shadows: report new version ────────────────────────────────────────
sleep 2
REPORTED_PAYLOAD=$(printf \
  '{"state":{"reported":{"telemetry_interval_ms":%s,"metrics":%s,"config_version":"1.0.0"}}}' \
  "$DESIRED_INTERVAL_MS" "$DESIRED_METRICS")
aws iot-data update-thing-shadow \
  --region "$REGION" \
  --endpoint-url "https://$IOT_ENDPOINT" \
  --thing-name "$INSTANCE_ID" \
  --shadow-name device-config \
  --cli-binary-format raw-in-base64-out \
  --payload "$REPORTED_PAYLOAD" \
  /dev/null

# NOTE: $package shadow is updated automatically by IoT Jobs (destinationPackageVersions) — do not write it here.

echo "telemetry-v1 applied successfully"
exit 0
# --8<-- [end:job-handler]
