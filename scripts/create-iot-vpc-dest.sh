#!/usr/bin/env bash
# Creates the shared IoT VPC destination for the workshop-cloud VPC and writes
# the confirmed ARN to SSM at /workshop/platform/iot-vpc-dest-arn.
#
# Must be run after WorkshopPlatformStack is fully deployed.
# Called automatically by sandbox-all.sh.
#
# Idempotent: if a destination in ENABLED state already exists for the VPC, it
# reuses it and just re-writes the SSM parameter.
#
# The SSM value is only trusted after confirming the destination it points to
# still actually exists and is ENABLED (see #202) — IoT topic rule destinations
# can be deleted out-of-band (manual cleanup, account/VPC changes) without the
# SSM parameter being cleared, in which case every rule referencing the stale
# ARN silently drops every record with "Destination ... does not exist."

set -euo pipefail

SSM_PARAM="/workshop/platform/iot-vpc-dest-arn"

# ── Trust the existing SSM value only if it still resolves to a real, ────────
# ENABLED destination. Re-runs where the dest is still IN_PROGRESS are also
# accepted here — the topic rule becomes functional once it reaches ENABLED.
EXISTING_SSM=$(aws ssm get-parameter --name "$SSM_PARAM" --query "Parameter.Value" --output text 2>/dev/null || echo "None")
if [[ "$EXISTING_SSM" != "None" && -n "$EXISTING_SSM" ]]; then
  EXISTING_SSM_STATUS=$(aws iot get-topic-rule-destination --arn "$EXISTING_SSM" \
    --query "topicRuleDestination.status" --output text 2>/dev/null || echo "NOT_FOUND")
  if [[ "$EXISTING_SSM_STATUS" == "ENABLED" || "$EXISTING_SSM_STATUS" == "IN_PROGRESS" ]]; then
    echo ">>> SSM $SSM_PARAM already set and destination is $EXISTING_SSM_STATUS: $EXISTING_SSM. Skipping."
    exit 0
  fi
  echo ">>> SSM $SSM_PARAM points to $EXISTING_SSM but destination status is '$EXISTING_SSM_STATUS' — treating as stale and recreating." >&2
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

# ── Confirm the platform stack is live ───────────────────────────────────────
PLATFORM_STACK="WorkshopPlatformStack"
STATUS=$(aws cloudformation describe-stacks \
  --stack-name "$PLATFORM_STACK" \
  --query "Stacks[0].StackStatus" \
  --output text 2>/dev/null || echo "DOES_NOT_EXIST")
if [[ "$STATUS" != "CREATE_COMPLETE" && "$STATUS" != "UPDATE_COMPLETE" ]]; then
  echo "ERROR: No healthy platform stack found. Is WorkshopPlatformStack deployed?" >&2
  exit 1
fi

# ── Look up platform stack outputs ───────────────────────────────────────────
# Use describe-stacks on the specific stack to avoid list-exports pagination
# producing multi-line output (each page adds a line, resulting in "None\nvalue").
ROLE_ARN=$(aws cloudformation describe-stacks --stack-name "$PLATFORM_STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='IotVpcDestRoleArn'].OutputValue | [0]" \
  --output text)
VPC_ID=$(aws cloudformation describe-stacks --stack-name "$PLATFORM_STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='CloudVpcId'].OutputValue | [0]" \
  --output text)
SUBNETS=$(aws cloudformation describe-stacks --stack-name "$PLATFORM_STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='CloudPrivateSubnets'].OutputValue | [0]" \
  --output text)
# Dedicated SG for IoT VPC destination ENIs — created by the platform stack
# (IotVpcDestSgId output). If the output is absent (older stack versions),
# create the SG here and tag it for idempotency.
SG_ID=$(aws cloudformation describe-stacks --stack-name "$PLATFORM_STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='IotVpcDestSgId'].OutputValue | [0]" \
  --output text 2>/dev/null || echo "None")

if [[ -z "$ROLE_ARN" || "$ROLE_ARN" == "None" ]]; then
  echo "ERROR: IotVpcDestRoleArn output not found. Is WorkshopPlatformStack deployed?" >&2
  exit 1
fi

if [[ -z "$SG_ID" || "$SG_ID" == "None" ]]; then
  echo ">>> IotVpcDestSgId not in stack outputs — checking for existing tagged SG..."
  SG_ID=$(aws ec2 describe-security-groups \
    --filters "Name=vpc-id,Values=$VPC_ID" "Name=tag:Name,Values=workshop-iot-vpc-dest-sg" \
    --query "SecurityGroups[0].GroupId" --output text 2>/dev/null || echo "None")

  if [[ -z "$SG_ID" || "$SG_ID" == "None" ]]; then
    echo ">>> Creating IoT VPC destination security group..."
    SG_ID=$(aws ec2 create-security-group \
      --group-name "workshop-iot-vpc-dest-sg" \
      --description "IoT VPC destination ENIs - allow TCP 443 for IoT health-check" \
      --vpc-id "$VPC_ID" \
      --query "GroupId" --output text)
    aws ec2 authorize-security-group-ingress \
      --group-id "$SG_ID" \
      --protocol tcp --port 443 --cidr "0.0.0.0/0"
    aws ec2 create-tags \
      --resources "$SG_ID" \
      --tags "Key=Name,Value=workshop-iot-vpc-dest-sg"
    echo ">>> Created SG: $SG_ID"
  else
    echo ">>> Reusing existing tagged SG: $SG_ID"
  fi
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
