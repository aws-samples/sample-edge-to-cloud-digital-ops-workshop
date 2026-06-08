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
