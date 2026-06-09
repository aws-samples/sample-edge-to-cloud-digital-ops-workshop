# Block 1 — Deploy Cloud Analytics Stack

**Duration:** 45 min

!!! warning "Session 4 — Work in Progress"
    The EKS cluster, Helm values files (`helm/risingwave-values.yaml`, `helm/rp-connect-timescaledb.yaml`), and Kubernetes manifests (`k8s/timescaledb-cluster.yaml`) are not yet deployed or committed to the repository. This session is **conceptual** until those assets are added.
    
    Facilitators: deploy the EKS cluster via CDK (`ParticipantStack` — add `eks.Cluster` construct) and commit the `helm/` and `k8s/` directories before this session.

---

## Steps

First, configure `kubectl` access to the pre-deployed EKS cluster:

```bash
aws eks update-kubeconfig \
  --region us-east-1 \
  --name workshop-{DEPLOYMENT_ID}-eks
```

Run Helm deployments against the pre-configured EKS cluster. All values files are pre-staged in the repository; MSK credentials are injected from Secrets Manager via EKS pod identity.

```bash
# Deploy RisingWave (consumes from MSK)
helm upgrade --install risingwave oci://ghcr.io/risingwavelabs/risingwave-operator \
  -n risingwave --create-namespace \
  -f helm/risingwave-values.yaml

# Deploy TimescaleDB via CloudNativePG
helm upgrade --install cnpg cloudnative-pg/cloudnative-pg \
  -n cnpg-system --create-namespace
kubectl apply -f k8s/timescaledb-cluster.yaml

# Deploy Redpanda Connect (MSK → TimescaleDB bulk insert pipeline)
helm upgrade --install rp-connect redpanda/connectors \
  -f helm/rp-connect-timescaledb.yaml
```

Wait for all pods to reach `Running`:

```bash
kubectl get pods -n risingwave
kubectl get pods -n cnpg-system
```

---

## References

- [RisingWave Kubernetes Operator](https://docs.risingwave.com/deploy/risingwave-kubernetes)
- [CloudNativePG](https://cloudnative-pg.io/documentation/)
