#!/usr/bin/env bash
# msk-tunnel.sh — laptop -> private MSK reachability via sshuttle over
# SSH-over-SSM, so simulator/frac-msk-load.py can produce directly to the
# cloud MSK cluster from an operator's own machine.
#
# WHY sshuttle + SSH-over-SSM instead of a plain SSM port-forward:
# `AWS-StartPortForwardingSessionToRemoteHost` forwards a single local port to
# a single remote host:port. MSK is a multi-broker cluster where each broker
# advertises its OWN DNS name on 9096 (SASL_SCRAM) — a Kafka client connects
# to the bootstrap broker, gets back a list of broker DNS names, and then
# opens NEW connections to each of those names directly. A single forwarded
# localhost port can't stand in for N distinct broker DNS names, so a plain
# port-forward breaks as soon as the client tries to follow a broker's
# advertised hostname. sshuttle instead routes the whole cloud VPC CIDR (and
# DNS, via --dns) through an SSH tunnel, so the broker DNS names resolve to
# their real private IPs and a stock kafka-python client connects exactly as
# it would from inside the VPC.
#
# Prerequisites (all on the machine running this script):
#   - sshuttle, ssh-keygen, aws CLI v2 on PATH
#   - AWS credentials for the workshop account with:
#       cloudformation:ListExports, ec2:DescribeInstances,
#       ec2-instance-connect:SendSSHPublicKey, ssm:StartSession
#   - The target EKS node's IAM role must allow the SSM agent (already true —
#     every EKS-managed-nodegroup worker in this platform runs it) and its
#     security group must allow the SSH-over-SSM document's ephemeral port.
#
# Usage:
#   scripts/msk-tunnel.sh                  # start the tunnel, block until Ctrl-C
#   scripts/msk-tunnel.sh --region us-west-2
#   AWS_REGION=us-east-1 scripts/msk-tunnel.sh
#
# Once running, in another terminal:
#   python simulator/frac-msk-load.py --slot ws-slot00 --hz 5 --duration 120
#
# Fallback (documented, not built unless this tunnel proves brittle): run
# frac-msk-load.py as a one-shot `kubectl run` pod in-cluster instead — same
# precedent as the e2e topic-creation pod — which has native MSK reachability
# and needs no tunnel at all.
set -euo pipefail

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
CLOUD_VPC_CIDR="${MSK_TUNNEL_CLOUD_VPC_CIDR:-10.1.0.0/16}"
SSH_USER="${MSK_TUNNEL_SSH_USER:-ec2-user}"
KEY_PATH="${MSK_TUNNEL_KEY_PATH:-$HOME/.ssh/msk-tunnel-ephemeral}"

usage() {
  cat <<'USAGE'
Usage: scripts/msk-tunnel.sh [--region <aws-region>]

Establishes laptop -> cloud-VPC MSK reachability via sshuttle over
SSH-over-SSM to an EKS worker node. Blocks until interrupted (Ctrl-C).

Env overrides:
  AWS_REGION / AWS_DEFAULT_REGION   AWS region (default: us-east-1)
  MSK_TUNNEL_CLOUD_VPC_CIDR         VPC CIDR to route (default: 10.1.0.0/16)
  MSK_TUNNEL_SSH_USER               remote SSH user (default: ec2-user)
  MSK_TUNNEL_KEY_PATH               ephemeral keypair path (default: ~/.ssh/msk-tunnel-ephemeral)
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)
      REGION="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: '$1' not found on PATH. $2" >&2
    exit 1
  fi
}

require_cmd aws "Install/configure the AWS CLI v2."
require_cmd sshuttle "Install it, e.g. 'brew install sshuttle' or 'pip install sshuttle'."
require_cmd ssh-keygen "Part of any OpenSSH client install."

echo "▶ Looking up the EKS cluster name ..." >&2
cluster_name=$(aws cloudformation list-exports \
  --region "$REGION" \
  --query "Exports[?Name=='workshop-eks-cluster-name'].Value" \
  --output text)

if [[ -z "$cluster_name" || "$cluster_name" == "None" ]]; then
  echo "ERROR: could not find the 'workshop-eks-cluster-name' CloudFormation export in $REGION." >&2
  echo "  Has the shared WorkshopPlatformStack been deployed?" >&2
  exit 1
fi
echo "  cluster: $cluster_name" >&2

echo "▶ Finding a running EKS worker node in the cloud VPC ..." >&2
target_line=$(aws ec2 describe-instances \
  --region "$REGION" \
  --filters "Name=tag:eks:cluster-name,Values=${cluster_name}" \
            "Name=instance-state-name,Values=running" \
  --query "Reservations[0].Instances[0].[InstanceId,PrivateIpAddress,Placement.AvailabilityZone]" \
  --output text)

instance_id=$(awk '{print $1}' <<<"$target_line")
availability_zone=$(awk '{print $3}' <<<"$target_line")

if [[ -z "$instance_id" || "$instance_id" == "None" ]]; then
  echo "ERROR: no running EC2 instance tagged eks:cluster-name=${cluster_name} in $REGION." >&2
  exit 1
fi
echo "  target: $instance_id ($availability_zone)" >&2

echo "▶ Preparing an ephemeral SSH keypair ..." >&2
if [[ ! -f "$KEY_PATH" ]]; then
  ssh-keygen -t ed25519 -N "" -f "$KEY_PATH" -C "msk-tunnel-ephemeral" >/dev/null
fi

echo "▶ Pushing the ephemeral public key via EC2 Instance Connect (valid ~60s) ..." >&2
aws ec2-instance-connect send-ssh-public-key \
  --region "$REGION" \
  --instance-id "$instance_id" \
  --instance-os-user "$SSH_USER" \
  --availability-zone "$availability_zone" \
  --ssh-public-key "file://${KEY_PATH}.pub" >/dev/null

ssh_proxy_cmd="aws ssm start-session --region ${REGION} --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p"
ssh_cmd="ssh -i ${KEY_PATH} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ProxyCommand=\"${ssh_proxy_cmd}\""

echo "▶ Starting sshuttle tunnel -> ${CLOUD_VPC_CIDR} via ${instance_id} (Ctrl-C to stop) ..." >&2
echo "  MSK broker DNS names will now resolve through this tunnel." >&2

# --dns routes DNS resolution through the tunnel too, so broker hostnames
# (advertised by the bootstrap broker on connect) resolve to their real
# private IPs instead of failing or resolving publicly.
exec sshuttle --dns -r "${SSH_USER}@${instance_id}" "$CLOUD_VPC_CIDR" --ssh-cmd "$ssh_cmd"
