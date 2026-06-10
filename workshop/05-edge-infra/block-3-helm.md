# Block 3 — Deploy Edge Helm Stack

**Duration:** 60 min

---

## Prerequisites

Verify K3s is up before proceeding:

```bash
# Retrieve kubeconfig written to SSM by the K3s install job
aws ssm get-parameter \
  --name /workshop/{DEPLOYMENT_ID}/kubeconfig \
  --with-decryption \
  --query Parameter.Value \
  --output text > ~/.kube/edge-config

export KUBECONFIG=~/.kube/edge-config
kubectl get nodes
```

All 3 nodes should show `Ready`.

---

## Create the MSK Credentials Secret

The WAN relay needs MSK credentials to authenticate to the cloud MSK cluster. Retrieve them from Secrets Manager and create a K8s Secret before the Helm install:

```bash
# Get MSK credentials from Secrets Manager
MSK_CREDS=$(aws secretsmanager get-secret-value \
  --secret-id AmazonMSK_workshop-{DEPLOYMENT_ID} \
  --query SecretString --output text)
MSK_USER=$(echo "$MSK_CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin)['username'])")
MSK_PASS=$(echo "$MSK_CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin)['password'])")

# Create the secret in the edge namespace
kubectl create namespace edge --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic msk-credentials \
  --namespace edge \
  --from-literal=MSK_USERNAME="$MSK_USER" \
  --from-literal=MSK_PASSWORD="$MSK_PASS"
```

---

## Deploy the Edge Stack

```bash
helm upgrade --install edge-stack ./helm/edge-stack \
  --namespace edge --create-namespace \
  -f helm/edge-stack-values.yaml \
  --set deploymentId={DEPLOYMENT_ID}
```

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

All pods should reach `Running` within ~5 minutes.

---

## Reference

- [K3s documentation](https://docs.k3s.io/)
