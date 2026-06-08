#!/bin/bash
# IoT Job handler: deploy K3s cluster across 3 edge nodes.
# Device 0 acts as the server; devices 1 and 2 join as agents.
# The server token is written to SSM Parameter Store so agents can read it.
# Exit 0 = SUCCESS; non-zero = FAILED.
set -euo pipefail

INSTANCE_ID=$(ec2-metadata --instance-id | cut -d' ' -f2)
REGION=$(ec2-metadata --availability-zone | cut -d' ' -f2 | sed 's/.$//')
DEPLOYMENT_ID="${DEPLOYMENT_ID:-ws-slot00}"
SSM_TOKEN_PATH="/workshop/${DEPLOYMENT_ID}/k3s-token"
SSM_KUBECONFIG_PATH="/workshop/${DEPLOYMENT_ID}/kubeconfig"
PRIVATE_IP=$(ec2-metadata --local-ipv4 | cut -d' ' -f2)

# ── Determine role: server or agent ──────────────────────────────────────────
# The IoT Job runs on all 3 devices in the Thing Group.
# Device 0 (lowest sort order by instance ID) acts as server.
# Other devices wait for the SSM token, then join.

# Get all devices in the group (sorted) to determine ordering
GROUP_THINGS=$(aws iot list-things-in-thing-group \
  --region "$REGION" \
  --thing-group-name "ws-${DEPLOYMENT_ID}" \
  --query "things" --output text | tr '\t' '\n' | sort)

FIRST_THING=$(echo "$GROUP_THINGS" | head -1)

if [ "$INSTANCE_ID" = "$FIRST_THING" ]; then
  # ── Server node ───────────────────────────────────────────────────────────
  echo "Starting K3s server on $INSTANCE_ID"
  curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="server --cluster-init" sh -

  # Wait for k3s to be ready
  until kubectl get nodes &>/dev/null; do sleep 3; done

  K3S_TOKEN=$(cat /var/lib/rancher/k3s/server/node-token)

  # Store token in SSM so agent nodes can read it
  aws ssm put-parameter \
    --region "$REGION" \
    --name "$SSM_TOKEN_PATH" \
    --value "$K3S_TOKEN" \
    --type "SecureString" \
    --overwrite

  # Store kubeconfig (with private IP as server URL — all nodes share subnet)
  K3S_CONFIG=$(cat /etc/rancher/k3s/k3s.yaml | \
    sed "s|127.0.0.1|${PRIVATE_IP}|g")

  aws ssm put-parameter \
    --region "$REGION" \
    --name "$SSM_KUBECONFIG_PATH" \
    --value "$K3S_CONFIG" \
    --type "SecureString" \
    --overwrite

  echo "K3s server ready; token and kubeconfig stored in SSM"
else
  # ── Agent node ────────────────────────────────────────────────────────────
  echo "Waiting for K3s server token in SSM…"
  for i in $(seq 1 30); do
    TOKEN=$(aws ssm get-parameter \
      --region "$REGION" \
      --name "$SSM_TOKEN_PATH" \
      --with-decryption \
      --query "Parameter.Value" --output text 2>/dev/null || true)
    if [ -n "$TOKEN" ]; then break; fi
    echo "  attempt $i/30, sleeping 10s…"
    sleep 10
  done

  if [ -z "$TOKEN" ]; then
    echo "ERROR: timed out waiting for K3s server token"
    exit 1
  fi

  SERVER_IP=$(echo "$GROUP_THINGS" | head -1 | xargs -I{} aws ec2 describe-instances \
    --region "$REGION" \
    --filters "Name=tag:aws:iot:thingName,Values={}" \
    --query "Reservations[0].Instances[0].PrivateIpAddress" --output text)

  # Fallback: resolve via SSM kubeconfig
  if [ -z "$SERVER_IP" ]; then
    SERVER_IP=$(aws ssm get-parameter \
      --region "$REGION" \
      --name "$SSM_KUBECONFIG_PATH" \
      --with-decryption \
      --query "Parameter.Value" --output text | \
      grep -oP 'server: https://\K[0-9.]+')
  fi

  echo "Joining K3s cluster at https://${SERVER_IP}:6443"
  curl -sfL https://get.k3s.io | \
    K3S_URL="https://${SERVER_IP}:6443" \
    K3S_TOKEN="$TOKEN" \
    sh -

  echo "K3s agent joined successfully"
fi

echo "deploy-k3s completed"
exit 0
