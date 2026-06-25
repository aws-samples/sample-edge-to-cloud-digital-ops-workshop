#!/bin/bash
# --8<-- [start:job-handler]
# IoT Job handler: shadow-driven telemetry config with 3-decimal measurement precision.
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

  aws iot-data publish \
    --endpoint-url "https://$IOT_ENDPOINT" \
    --topic "edge/$DEPLOYMENT_ID/$INSTANCE_ID/telemetry" \
    --payload "$PAYLOAD" \
    --cli-binary-format raw-in-base64-out \
    2>/dev/null || true

  sleep "$SLEEP_S"
done
TELEMETRY

chmod +x "$TELEMETRY_SCRIPT"

# ── Restart telemetry service ──────────────────────────────────────────────────
systemctl restart workshop-telemetry

# ── Update shadows: report new version ────────────────────────────────────────
sleep 2
REPORTED_PAYLOAD=$(printf \
  '{"state":{"reported":{"telemetry_interval_ms":%s,"metrics":%s,"config_version":"3.0.0"}}}' \
  "$DESIRED_INTERVAL_MS" "$DESIRED_METRICS")
aws iot-data update-thing-shadow \
  --region "$REGION" \
  --endpoint-url "https://$IOT_ENDPOINT" \
  --thing-name "$INSTANCE_ID" \
  --shadow-name device-config \
  --cli-binary-format raw-in-base64-out \
  --payload "$REPORTED_PAYLOAD" \
  /dev/null

aws iot-data update-thing-shadow \
  --region "$REGION" \
  --endpoint-url "https://$IOT_ENDPOINT" \
  --thing-name "$INSTANCE_ID" \
  --shadow-name '$package' \
  --cli-binary-format raw-in-base64-out \
  --payload '{"state":{"reported":{"telemetry-agent":{"version":"3.0.0"}}}}' \
  /dev/null

echo "telemetry-v3 applied successfully"
exit 0
# --8<-- [end:job-handler]
