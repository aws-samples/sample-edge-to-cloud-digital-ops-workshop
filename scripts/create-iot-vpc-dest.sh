#!/usr/bin/env bash
# Creates the shared IoT VPC destination for the workshop-cloud VPC and writes
# the confirmed ARN to SSM at /workshop/platform/iot-vpc-dest-arn.
#
# Must be run after WorkshopPlatformStack is fully deployed.
# Called automatically by sandbox-all.sh.
#
# Idempotent: if a destination in ENABLED state already exists for the VPC, it
# reuses it and just re-writes the SSM parameter.

set -euo pipefail

SSM_PARAM="/workshop/platform/iot-vpc-dest-arn"

# ── Short-circuit: if SSM already has a value, trust it and exit quickly ─────
# This handles re-runs where the dest is still IN_PROGRESS but the ARN is known.
# The topic rule will become functional once the dest eventually reaches ENABLED.
EXISTING_SSM=$(aws ssm get-parameter --name "$SSM_PARAM" --query "Parameter.Value" --output text 2>/dev/null || echo "None")
if [[ "$EXISTING_SSM" != "None" && -n "$EXISTING_SSM" ]]; then
  echo ">>> SSM $SSM_PARAM already set: $EXISTING_SSM. Skipping wait."
  exit 0
fi

# ── Check for existing ENABLED or IN_PROGRESS destination ────────────────────
EXISTING_ARN=$(aws iot list-topic-rule-destinations \
  --query "destinationSummaries[?status=='ENABLED'].arn | [0]" \
  --output text 2>/dev/null || echo "None")

if [[ "$EXISTING_ARN" != "None" && -n "$EXISTING_ARN" ]]; then
  echo ">>> IoT VPC destination already ENABLED: $EXISTING_ARN"
  aws ssm put-parameter \
    --name "$SSM_PARAM" \
    --value "$EXISTING_ARN" \
    --type String \
    --overwrite
  echo ">>> SSM $SSM_PARAM updated."
  exit 0
fi

# If a destination is IN_PROGRESS, wait for it to become ENABLED rather than
# creating a duplicate (duplicates cannot be deleted until fully created).
IN_PROGRESS_ARN=$(aws iot list-topic-rule-destinations \
  --query "destinationSummaries[?status=='IN_PROGRESS'].arn | [0]" \
  --output text 2>/dev/null || echo "None")

if [[ "$IN_PROGRESS_ARN" != "None" && -n "$IN_PROGRESS_ARN" ]]; then
  echo ">>> Found IN_PROGRESS destination: $IN_PROGRESS_ARN. Waiting for ENABLED (up to 20 min)..."
  DEST_ARN="$IN_PROGRESS_ARN"
  STATUS="IN_PROGRESS"
  for attempt in $(seq 1 120); do
    STATUS=$(aws iot get-topic-rule-destination \
      --arn "$DEST_ARN" \
      --query "topicRuleDestination.status" \
      --output text 2>/dev/null || echo "UNKNOWN")
    echo "  Attempt $attempt/120: status=$STATUS"
    if [[ "$STATUS" == "ENABLED" ]]; then break; fi
    if [[ "$STATUS" == "ERROR" ]]; then
      echo "ERROR: Destination reached ERROR state. Delete and retry." >&2
      exit 1
    fi
    sleep 10
  done
  if [[ "$STATUS" == "ENABLED" ]]; then
    aws ssm put-parameter --name "$SSM_PARAM" --value "$DEST_ARN" --type String --overwrite
    echo ">>> IoT VPC destination ready: $DEST_ARN"
    exit 0
  fi
  echo "ERROR: Destination $DEST_ARN still not ENABLED after 20 min. Status: $STATUS" >&2
  exit 1
fi

# ── Look up platform stack outputs ───────────────────────────────────────────
# Use describe-stacks on the specific stack to avoid list-exports pagination
# producing multi-line output (each page adds a line, resulting in "None\nvalue").
ROLE_ARN=$(aws cloudformation describe-stacks --stack-name WorkshopPlatformStack \
  --query "Stacks[0].Outputs[?OutputKey=='IotVpcDestRoleArn'].OutputValue | [0]" \
  --output text)
VPC_ID=$(aws cloudformation describe-stacks --stack-name WorkshopPlatformStack \
  --query "Stacks[0].Outputs[?OutputKey=='CloudVpcId'].OutputValue | [0]" \
  --output text)
SUBNETS=$(aws cloudformation describe-stacks --stack-name WorkshopPlatformStack \
  --query "Stacks[0].Outputs[?OutputKey=='CloudPrivateSubnets'].OutputValue | [0]" \
  --output text)
# Dedicated SG for IoT VPC destination ENIs (allows TCP 443 inbound for IoT health-check).
# The MSK SG only opens 9096/9098 which blocks the IoT validation handshake.
SG_ID="sg-0a87b81fca83f0234"

if [[ -z "$ROLE_ARN" || "$ROLE_ARN" == "None" ]]; then
  echo "ERROR: workshop-platform-iot-vpc-dest-role-arn export not found. Is WorkshopPlatformStack deployed?" >&2
  exit 1
fi

echo ">>> Creating IoT VPC destination (VPC=$VPC_ID, role=$ROLE_ARN)..."

# Build destination config JSON safely with jq to avoid quoting/newline issues
DEST_CONFIG=$(jq -n \
  --arg vpcId "$VPC_ID" \
  --arg roleArn "$ROLE_ARN" \
  --arg sgId "$SG_ID" \
  --argjson subnetIds "$(echo "$SUBNETS" | tr ',' '\n' | jq -R . | jq -s .)" \
  '{vpcConfiguration:{vpcId:$vpcId,subnetIds:$subnetIds,securityGroups:[$sgId],roleArn:$roleArn}}')

DEST_ARN=$(aws iot create-topic-rule-destination \
  --destination-configuration "$DEST_CONFIG" \
  --query "topicRuleDestination.arn" \
  --output text)

echo ">>> Destination created: $DEST_ARN. Waiting for ENABLED status (up to 15 min)..."

# IoT VPC destinations auto-transition to ENABLED once ENIs are attached.
for attempt in $(seq 1 90); do
  STATUS=$(aws iot get-topic-rule-destination \
    --arn "$DEST_ARN" \
    --query "topicRuleDestination.status" \
    --output text 2>/dev/null || echo "UNKNOWN")
  echo "  Attempt $attempt/30: status=$STATUS"
  if [[ "$STATUS" == "ENABLED" ]]; then
    break
  fi
  sleep 10
done

if [[ "$STATUS" != "ENABLED" ]]; then
  echo "ERROR: VPC destination $DEST_ARN did not reach ENABLED status after 15 min. Status: $STATUS" >&2
  exit 1
fi

echo ">>> Writing ARN to SSM $SSM_PARAM..."
aws ssm put-parameter \
  --name "$SSM_PARAM" \
  --value "$DEST_ARN" \
  --type String \
  --overwrite

echo ">>> IoT VPC destination ready: $DEST_ARN"
