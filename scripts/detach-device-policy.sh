#!/usr/bin/env bash
# Detaches an IoT policy from all principals currently attached to it, so
# CloudFormation can delete the AWS::IoT::Policy resource.
set -euo pipefail
POLICY="$1"
aws iot list-targets-for-policy --policy-name "$POLICY" --output text | awk '{print $2}' | while read -r CERT_ARN; do
  [[ -z "$CERT_ARN" ]] && continue
  echo "Detaching $CERT_ARN from $POLICY"
  aws iot detach-policy --policy-name "$POLICY" --target "$CERT_ARN"
done
echo "Remaining targets for $POLICY:"
aws iot list-targets-for-policy --policy-name "$POLICY" --output text
