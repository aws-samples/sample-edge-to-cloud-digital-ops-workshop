# Block 3 — Deploy Edge Helm Stack

**Duration:** 60 min

---

## Prerequisites

Verify K3s is up before proceeding. The kubeconfig that the install job wrote to
SSM points at the server node's **private** IP (`https://10.x.x.x:6443`),
reachable only from inside the edge VPC. Because you're driving `kubectl` from
your laptop (or CI) with no VPC route, open an SSM port-forward to the K3s server
and point `kubectl` at `127.0.0.1` — K3s's server certificate already lists
`127.0.0.1` and `localhost` as SANs, so TLS still verifies (no
`--insecure-skip-tls-verify`):

```bash
# Retrieve kubeconfig written to SSM by the K3s install job
mkdir -p ~/.kube
aws ssm get-parameter \
  --name /workshop/ws-slot00/kubeconfig \
  --with-decryption \
  --query Parameter.Value \
  --output text > ~/.kube/edge-config
export KUBECONFIG=~/.kube/edge-config

# The server node is the lowest-sorted instance ID in the Thing Group —
# the same node deploy-k3s.sh elected as server.
K3S_SERVER_ID=$(aws iot list-things-in-thing-group \
  --thing-group-name ws-slot00-devices \
  --query "things" --output text | tr '\t' '\n' | sort | head -1)

# Forward local 6443 → the server's own 6443 over SSM (no public ingress).
# The tunnel keeps running in the background for the Helm steps below.
aws ssm start-session \
  --target "$K3S_SERVER_ID" \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["6443"],"localPortNumber":["6443"]}' \
  > /tmp/k3s-ssm-pf.log 2>&1 &
SSM_PF_PID=$!
sleep 8

# Rewrite the kubeconfig server to the tunnel endpoint.
sed -i.bak -E 's#server: https://[0-9.]+:6443#server: https://127.0.0.1:6443#' \
  ~/.kube/edge-config

kubectl get nodes
# When finished with the edge cluster: kill "$SSM_PF_PID"
```
<!-- e2e:assert {"contains": "Ready"} -->

All 3 nodes should show `Ready`. This needs `ssm:StartSession` on the instance
plus the SSM Session Manager plugin installed locally.

!!! tip "Already inside the edge VPC?"
    If you're running from a host with a route into the edge VPC (a bastion or a
    workload in a peered subnet), skip the tunnel — use the kubeconfig's private
    IP directly and just run `export KUBECONFIG=~/.kube/edge-config` before the
    Helm steps.

---

## Create the MSK Credentials Secret

The WAN relay needs MSK credentials to authenticate to the cloud MSK cluster. Retrieve them from Secrets Manager and create a K8s Secret before the Helm install:

```bash
# Get MSK credentials from Secrets Manager
MSK_CREDS=$(aws secretsmanager get-secret-value \
  --secret-id AmazonMSK_workshop-ws-slot00 \
  --query SecretString --output text)
MSK_USER=$(echo "$MSK_CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin)['username'])")
MSK_PASS=$(echo "$MSK_CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin)['password'])")

# Create the secret in the edge namespace (idempotent — re-runnable if the
# secret already exists from an earlier attempt).
kubectl create namespace edge --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic msk-credentials \
  --namespace edge \
  --from-literal=MSK_USERNAME="$MSK_USER" \
  --from-literal=MSK_PASSWORD="$MSK_PASS" \
  --dry-run=client -o yaml | kubectl apply -f -
```
<!-- e2e:assert {"contains": "secret/msk-credentials"} -->

---

## Deploy the Edge Stack

The release needs two slot-specific endpoints that aren't known until deploy
time, so discover them and pass them on the command line (these override the
placeholders in `helm/edge-stack-values.yaml`, so you don't have to hand-edit the
file):

- **`mqtt.host`** — the sensor simulator EC2's **private IP** (the ingest
  pipeline connects to its Mosquitto broker).
- **`mskBootstrapServers`** — the **shared** MSK cluster's SASL/SCRAM bootstrap
  brokers (the WAN relay forwards `sensors.raw.*` there).

```bash
SIM_IP=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=workshop-ws-slot00-sensor-sim" \
            "Name=instance-state-name,Values=running" \
  --query "Reservations[0].Instances[0].PrivateIpAddress" \
  --output text)

MSK_ARN=$(aws cloudformation list-exports \
  --query "Exports[?Name=='workshop-platform-msk-arn'].Value" --output text)
MSK_BROKERS=$(aws kafka get-bootstrap-brokers --cluster-arn "$MSK_ARN" \
  --query "BootstrapBrokerStringSaslScram" --output text)
# helm --set treats commas as key separators, so escape the commas between brokers.
MSK_BROKERS_ESC="${MSK_BROKERS//,/\\,}"

helm dependency update helm/edge-stack
helm upgrade --install edge-stack ./helm/edge-stack \
  --namespace edge --create-namespace \
  -f helm/edge-stack-values.yaml \
  --set deploymentId=ws-slot00 \
  --set mqtt.host="$SIM_IP" \
  --set mskBootstrapServers="$MSK_BROKERS_ESC"
```
<!-- e2e:assert {"contains": "edge-stack"} -->

This deploys in a single Helm umbrella chart:

- **Redpanda** — 3-node Raft cluster
- **Redpanda Connect (ingest)** — MQTT → Redpanda bridge
- **Redpanda Connect (relay)** — Redpanda → Cloud MSK WAN relay
- **Edge RisingWave** — streaming compute
- **TimescaleDB (CNPG)** — time-series storage
- **MinIO** — RisingWave checkpoints
- **Next.js HMI** — operator interface

---

## Verify

```bash
kubectl get pods -n edge
```
<!-- e2e:assert {"contains": "NAME"} -->

All pods should reach `Running` within ~5 minutes.

---

## Reference

- [K3s documentation](https://docs.k3s.io/)
