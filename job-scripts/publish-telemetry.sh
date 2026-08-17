#!/bin/bash
# Resolve this instance's ID via IMDSv2 at startup with retry
TOKEN=$(curl -s --max-time 5 -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null)
for _i in $(seq 1 15); do
  INSTANCE_ID=$(curl -s --max-time 3 \
    -H "X-aws-ec2-metadata-token: $TOKEN" \
    "http://169.254.169.254/latest/meta-data/instance-id" 2>/dev/null)
  [ -n "$INSTANCE_ID" ] && break
  sleep 3
  TOKEN=$(curl -s --max-time 5 -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null)
done

DEPLOYMENT_ID="${DEPLOYMENT_ID:-ws-slot00}"
AZ=$(curl -s --max-time 3 \
  -H "X-aws-ec2-metadata-token: $TOKEN" \
  "http://169.254.169.254/latest/meta-data/placement/availability-zone" 2>/dev/null)
REGION="${AZ%?}"
IOT_ENDPOINT=$(aws iot describe-endpoint \
  --region "$REGION" \
  --endpoint-type iot:Data-ATS \
  --query endpointAddress --output text)

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
coproc MQTT_PUB { python3 /usr/local/bin/mqtt-publisher.py \
  --endpoint "$IOT_ENDPOINT" \
  --region "$REGION" \
  --topic "edge/$DEPLOYMENT_ID/$INSTANCE_ID/telemetry" \
  --client-id "${INSTANCE_ID}-telemetry-pub"; }

while true; do
  # Collect measurements; top -bn1 takes ~100ms to sample CPU
  CPU=$(top -bn1 | grep "Cpu(s)" | awk '{printf "%.3f", $2+0}')
  MEM=$(free | awk '/Mem:/ {printf "%.3f", $3/$2*100}')
  DISK=$(df / | awk 'NR==2 {printf "%.3f", $5+0}')

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
