#!/bin/bash
# --8<-- [start:job-handler]
# IoT Job handler: update telemetry to 1 Hz and add network metrics.
# Exit 0 = SUCCESS reported to IoT Jobs; non-zero = FAILED.
set -euo pipefail

INSTANCE_ID=$(ec2-metadata --instance-id | cut -d' ' -f2)
REGION=$(ec2-metadata --availability-zone | cut -d' ' -f2 | sed 's/.$//')
IOT_ENDPOINT=$(aws iot describe-endpoint --region "$REGION" --endpoint-type iot:Data-ATS --query endpointAddress --output text)

TELEMETRY_SCRIPT=/etc/aws-iot-device-client/jobs/publish-telemetry.sh

# ── Write updated telemetry script ────────────────────────────────────────────
cat > "$TELEMETRY_SCRIPT" <<'TELEMETRY'
#!/bin/bash
INSTANCE_ID=$(ec2-metadata --instance-id | cut -d' ' -f2)
DEPLOYMENT_ID="${DEPLOYMENT_ID:-ws-slot00}"
IOT_ENDPOINT=$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text)
PREV_SENT=0
PREV_RECV=0

while true; do
  # Collect measurements first (top -bn1 takes ~100ms to sample CPU)
  CPU=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | tr -d '%us,')
  MEM=$(free | awk '/Mem:/ {printf "%.1f", $3/$2*100}')
  DISK=$(df / | awk 'NR==2 {print $5}' | tr -d '%')

  # Network I/O delta
  NET_LINE=$(cat /proc/net/dev | grep -E 'eth0|ens5' | head -1)
  NET_RECV=$(echo "$NET_LINE" | awk '{print $2}')
  NET_SENT=$(echo "$NET_LINE" | awk '{print $10}')
  NET_IO_RECV=$((NET_RECV - PREV_RECV))
  NET_IO_SENT=$((NET_SENT - PREV_SENT))
  PREV_RECV=$NET_RECV
  PREV_SENT=$NET_SENT

  # Stamp timestamp immediately before publish so message_timestamp reflects when data leaves the node
  TS=$(date -u +%s%3N)
  PAYLOAD=$(printf \
    '{"thing_name":"%s","message_timestamp":%s,"cpu_pct":%s,"mem_used_pct":%s,"disk_used_pct":%s,"net_io_bytes_sent":%s,"net_io_bytes_recv":%s}' \
    "$INSTANCE_ID" "$TS" "$CPU" "$MEM" "$DISK" "$NET_IO_SENT" "$NET_IO_RECV")

  aws iot-data publish \
    --endpoint-url "https://$IOT_ENDPOINT" \
    --topic "edge/$DEPLOYMENT_ID/$INSTANCE_ID/telemetry" \
    --payload "$PAYLOAD" \
    --cli-binary-format raw-in-base64-out \
    2>/dev/null || true

  sleep 0.1
done
TELEMETRY

chmod +x "$TELEMETRY_SCRIPT"

# ── Restart telemetry service ──────────────────────────────────────────────────
systemctl restart workshop-telemetry

# ── Update shadows: report new version ────────────────────────────────────────
sleep 2
aws iot-data update-thing-shadow \
  --region "$REGION" \
  --endpoint-url "https://$IOT_ENDPOINT" \
  --thing-name "$INSTANCE_ID" \
  --shadow-name device-config \
  --cli-binary-format raw-in-base64-out \
  --payload '{"state":{"reported":{"telemetry_interval_ms":1000,"metrics":["cpu_pct","mem_used_pct","disk_used_pct","net_io_bytes_sent","net_io_bytes_recv"],"config_version":"2.0.0"}}}' \
  /dev/null

# NOTE: $package shadow is updated automatically by IoT Jobs (destinationPackageVersions) — do not write it here.

echo "telemetry-v2 applied successfully"
exit 0
# --8<-- [end:job-handler]
