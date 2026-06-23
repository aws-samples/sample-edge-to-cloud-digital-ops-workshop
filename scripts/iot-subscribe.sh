#!/usr/bin/env bash
# Subscribe to an IoT Core MQTT topic and print messages for a set duration.
# Usage:
#   ./scripts/iot-subscribe.sh "edge/ws-slot00/+/telemetry"
#   ./scripts/iot-subscribe.sh "edge/#" --duration 60
#   REGION=us-west-2 ./scripts/iot-subscribe.sh "my/topic"
#
# Options:
#   -d, --duration  Seconds to listen (default: 30)
#   -r, --raw       Print raw JSON without pretty-printing
#
# Requires: aws CLI v2, python3, mosquitto_sub (or falls back to aws iot-data
# subscribe via polling). Wildcard topics (+, #) require mosquitto_sub.

set -euo pipefail

REGION="${REGION:-us-east-1}"
DURATION=30
RAW=false
TOPIC=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--duration) DURATION="$2"; shift 2 ;;
    -r|--raw)      RAW=true; shift ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    *)  TOPIC="$1"; shift ;;
  esac
done

if [[ -z "$TOPIC" ]]; then
  echo "Usage: $0 <topic> [-d seconds] [-r]" >&2
  echo "  Example: $0 'edge/ws-slot00/+/telemetry'" >&2
  exit 1
fi

IOT_ENDPOINT=$(aws iot describe-endpoint \
  --region "$REGION" \
  --endpoint-type iot:Data-ATS \
  --query endpointAddress --output text)

echo "Endpoint : $IOT_ENDPOINT" >&2
echo "Topic    : $TOPIC" >&2
echo "Duration : ${DURATION}s" >&2
echo "---" >&2

# ── Pretty-printer ────────────────────────────────────────────────────────────
pretty() {
  if $RAW; then
    cat
  else
    python3 -c "
import sys, json
for line in sys.stdin:
    line = line.rstrip()
    if not line:
        continue
    try:
        print(json.dumps(json.loads(line), indent=2))
    except Exception:
        print(line)
"
  fi
}

# ── Prefer mosquitto_sub (supports wildcards) ─────────────────────────────────
if command -v mosquitto_sub >/dev/null 2>&1; then
  # Use mutual TLS with temporary certs vended by IoT Core
  CERT_DIR=$(mktemp -d)
  trap 'rm -rf "$CERT_DIR"' EXIT

  # Fetch a temporary X.509 cert for this session using aws CLI creds
  aws iot create-keys-and-certificate \
    --region "$REGION" \
    --set-as-active \
    --certificate-pem-outfile  "$CERT_DIR/cert.pem" \
    --public-key-outfile       "$CERT_DIR/pub.key" \
    --private-key-outfile      "$CERT_DIR/priv.key" \
    --query 'certificateArn' --output text > "$CERT_DIR/cert-arn.txt" 2>/dev/null

  CERT_ARN=$(cat "$CERT_DIR/cert-arn.txt")

  # Attach a temporary policy allowing subscribe/receive
  POLICY_NAME="iot-subscribe-tmp-$$"
  aws iot create-policy \
    --region "$REGION" \
    --policy-name "$POLICY_NAME" \
    --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"iot:Connect\",\"iot:Subscribe\",\"iot:Receive\"],\"Resource\":\"*\"}]}" \
    --output none 2>/dev/null

  aws iot attach-policy \
    --region "$REGION" \
    --policy-name "$POLICY_NAME" \
    --target "$CERT_ARN" 2>/dev/null

  # Fetch AmazonRootCA
  curl -s "https://www.amazontrust.com/repository/AmazonRootCA1.pem" \
    -o "$CERT_DIR/root-ca.pem"

  cleanup() {
    aws iot detach-policy --region "$REGION" --policy-name "$POLICY_NAME" --target "$CERT_ARN" 2>/dev/null || true
    aws iot delete-policy --region "$REGION" --policy-name "$POLICY_NAME" 2>/dev/null || true
    CERT_ID=$(echo "$CERT_ARN" | cut -d/ -f2)
    aws iot update-certificate --region "$REGION" --certificate-id "$CERT_ID" --new-status INACTIVE 2>/dev/null || true
    aws iot delete-certificate --region "$REGION" --certificate-id "$CERT_ID" 2>/dev/null || true
    rm -rf "$CERT_DIR"
  }
  trap cleanup EXIT

  echo "(mosquitto_sub — Ctrl-C to stop early)" >&2
  timeout "$DURATION" mosquitto_sub \
    --cafile  "$CERT_DIR/root-ca.pem" \
    --cert    "$CERT_DIR/cert.pem" \
    --key     "$CERT_DIR/priv.key" \
    -h        "$IOT_ENDPOINT" \
    -p        8883 \
    -t        "$TOPIC" \
    -i        "iot-subscribe-cli-$$" \
    -q        1 \
    --nodelay 2>/dev/null | pretty || true

# ── Fallback: AWS CLI polling (exact topics only, no wildcards) ───────────────
else
  echo "(mosquitto_sub not found — falling back to aws iot-data subscribe)" >&2
  echo "(Note: wildcards not supported in fallback mode)" >&2

  if [[ "$TOPIC" == *"+"* || "$TOPIC" == *"#"* ]]; then
    echo "ERROR: Wildcard topics require mosquitto_sub. Install it with:" >&2
    echo "  brew install mosquitto      # macOS" >&2
    echo "  sudo apt install mosquitto-clients  # Debian/Ubuntu" >&2
    exit 1
  fi

  END=$(($(date +%s) + DURATION))
  while [[ $(date +%s) -lt $END ]]; do
    RESULT=$(aws iot-data get-retained-message \
      --region "$REGION" \
      --topic "$TOPIC" \
      --output json 2>/dev/null) || true
    if [[ -n "$RESULT" ]]; then
      PAYLOAD=$(echo "$RESULT" | python3 -c "
import sys, json, base64
d = json.load(sys.stdin)
raw = d.get('payload', '')
if raw:
    print(base64.b64decode(raw).decode('utf-8', errors='replace'))
")
      if [[ -n "$PAYLOAD" ]]; then
        echo "$PAYLOAD" | pretty
      fi
    fi
    sleep 2
  done
fi

echo "---" >&2
echo "Done (${DURATION}s)." >&2
