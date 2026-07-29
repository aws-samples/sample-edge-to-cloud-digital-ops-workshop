#!/usr/bin/env bash
# edge-kubeconfig.sh — open an SSM port-forward to a slot's private K3s server
# and point kubectl at it, so `kubectl` reaches the edge cluster from a laptop or
# CI runner with no route into the edge VPC (issue #70, item 2).
#
# The K3s API server listens on a VPC-private IP with no public ingress. This
# script forwards local :6443 → the server node's :6443 over SSM Session Manager
# (no bastion, no VPN) and rewrites the SSM-stored kubeconfig to 127.0.0.1 —
# which is a SAN on the K3s server cert, so TLS still verifies. This is the same
# sequence documented inline in workshop/05-edge-infra/block-3-helm.md, factored
# out so ops/CI can reuse it without copy-paste drift.
#
# Usage:
#   # Source it to set KUBECONFIG in your current shell and keep the tunnel up:
#   source scripts/edge-kubeconfig.sh ws-slot00
#   kubectl get pods -n edge
#   edge_kubeconfig_close        # tear the tunnel down when done
#
#   # Or run it to open the tunnel, run one command, and close:
#   scripts/edge-kubeconfig.sh ws-slot00 -- kubectl get nodes
#
# Environment:
#   AWS_REGION    (default: us-east-1)
#   LOCAL_PORT    local port to forward (default: 6443)
set -uo pipefail

_edge_region="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
_edge_local_port="${LOCAL_PORT:-6443}"

edge_kubeconfig_close() {
  if [[ -n "${EDGE_SSM_PF_PID:-}" ]] && kill -0 "$EDGE_SSM_PF_PID" 2>/dev/null; then
    kill "$EDGE_SSM_PF_PID" 2>/dev/null || true
    echo "Closed edge SSM tunnel (pid $EDGE_SSM_PF_PID)."
  fi
  unset EDGE_SSM_PF_PID
}

edge_kubeconfig_open() {
  local deployment_id="$1"
  if [[ -z "$deployment_id" ]]; then
    echo "Usage: edge_kubeconfig_open <ws-slotNN>" >&2
    return 1
  fi

  mkdir -p ~/.kube
  local cfg=~/.kube/edge-config-"$deployment_id"

  echo "▶ Fetching kubeconfig for $deployment_id from SSM..." >&2
  if ! aws ssm get-parameter --region "$_edge_region" \
        --name "/workshop/$deployment_id/kubeconfig" \
        --with-decryption --query Parameter.Value --output text > "$cfg" 2>/dev/null; then
    echo "ERROR: /workshop/$deployment_id/kubeconfig not found. Has the K3s job run?" >&2
    return 1
  fi

  # Server node = lowest-sorted instance ID in the Thing Group (deploy-k3s.sh's
  # election rule).
  local server_id
  server_id=$(aws iot list-things-in-thing-group --region "$_edge_region" \
    --thing-group-name "$deployment_id-devices" \
    --query "things" --output text | tr '\t' '\n' | sort | head -1)
  if [[ -z "$server_id" ]]; then
    echo "ERROR: no things in $deployment_id-devices thing group." >&2
    return 1
  fi
  echo "▶ K3s server node: $server_id" >&2

  aws ssm start-session --region "$_edge_region" \
    --target "$server_id" \
    --document-name AWS-StartPortForwardingSession \
    --parameters "{\"portNumber\":[\"6443\"],\"localPortNumber\":[\"$_edge_local_port\"]}" \
    > /tmp/k3s-ssm-pf-"$deployment_id".log 2>&1 &
  export EDGE_SSM_PF_PID=$!
  sleep 8

  # Rewrite the private server IP to the local tunnel endpoint.
  sed -i.bak -E "s#server: https://[0-9.]+:6443#server: https://127.0.0.1:$_edge_local_port#" "$cfg"
  export KUBECONFIG="$cfg"
  echo "▶ KUBECONFIG=$KUBECONFIG (tunnel pid $EDGE_SSM_PF_PID)" >&2
  echo "  Run 'edge_kubeconfig_close' to tear down the tunnel." >&2
}

# ── Entry point ───────────────────────────────────────────────────────────────
# If sourced, expose the functions and open the tunnel for arg 1.
# If executed with `-- cmd...`, open, run the command, then close.
_edge_args=("$@")
_edge_deployment_id="${1:-}"

if (return 0 2>/dev/null); then
  # Sourced
  [[ -n "$_edge_deployment_id" ]] && edge_kubeconfig_open "$_edge_deployment_id"
else
  # Executed
  set -e
  if [[ -z "$_edge_deployment_id" ]]; then
    echo "Usage: $0 <ws-slotNN> [-- <command...>]" >&2
    exit 1
  fi
  shift
  edge_kubeconfig_open "$_edge_deployment_id" || exit 1
  trap edge_kubeconfig_close EXIT
  if [[ "${1:-}" == "--" ]]; then
    shift
    "$@"
  else
    echo "Tunnel open. KUBECONFIG=$KUBECONFIG" >&2
    echo "(No command given; tunnel will close when this process exits.)" >&2
  fi
fi
