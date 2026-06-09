# Block 1 — Deploy Cloud Analytics Stack

**Duration:** 45 min

---

## Steps

**1. Configure kubectl access to the shared EKS cluster**

The cluster is shared across all participants and pre-created by the platform stack:

```bash
aws eks update-kubeconfig \
  --region us-east-1 \
  --name workshop-eks
```

Confirm nodes are Ready:

```bash
kubectl get nodes
```

**2. Add Helm repos**

```bash
helm repo add risingwavelabs https://risingwavelabs.github.io/helm-charts
helm repo add redpanda https://charts.redpanda.com
helm repo add cloudnative-pg https://cloudnative-pg.github.io/charts
helm repo update
```

**3. Retrieve MSK credentials**

```bash
# Get the auto-generated MSK password from Secrets Manager
aws secretsmanager get-secret-value \
  --secret-id /workshop/{DEPLOYMENT_ID}/msk-credentials \
  --query SecretString --output text | python3 -m json.tool

# Get MSK bootstrap brokers
aws kafka get-bootstrap-brokers \
  --cluster-arn $(aws kafka list-clusters-v2 \
    --filter-by-name "workshop-{DEPLOYMENT_ID}-msk" \
    --query "ClusterInfoList[0].ClusterArn" --output text) \
  --query BootstrapBrokerStringSaslScram512 --output text
```

Create a Kubernetes Secret with these values (used by Redpanda Connect and RisingWave):

```bash
kubectl create namespace {DEPLOYMENT_ID}
kubectl create secret generic msk-credentials \
  --namespace {DEPLOYMENT_ID} \
  --from-literal=username=workshop-{DEPLOYMENT_ID} \
  --from-literal=password=<password-from-above> \
  --from-literal=bootstrap-servers=<brokers-from-above>
```

**4. Deploy RisingWave operator and instance**

The RisingWave operator is cluster-scoped and shared — install it once into `risingwave-system` if not already present:

```bash
helm upgrade --install risingwave-operator risingwavelabs/risingwave-operator \
  --namespace risingwave-system --create-namespace \
  -f helm/risingwave-values.yaml

# Wait for operator
kubectl wait --for=condition=available deployment/risingwave-operator-controller-manager \
  -n risingwave-system --timeout=120s

# Deploy the RisingWave CR into your participant namespace
sed "s/\${DEPLOYMENT_ID}/{DEPLOYMENT_ID}/g" k8s/risingwave-cloud.yaml | kubectl apply -n {DEPLOYMENT_ID} -f -
```

**5. Deploy TimescaleDB via CloudNativePG**

The CNPG operator is cluster-scoped and shared — install once into `cnpg-system` if not already present:

```bash
helm upgrade --install cnpg cloudnative-pg/cloudnative-pg \
  --namespace cnpg-system --create-namespace

# Wait for operator
kubectl wait --for=condition=available deployment/cnpg-cloudnative-pg \
  -n cnpg-system --timeout=120s

kubectl apply -f k8s/timescaledb-cloud-cluster.yaml -n {DEPLOYMENT_ID}
```

**6. Deploy Redpanda Connect (MSK → TimescaleDB)**

Update `helm/rp-connect-timescaledb.yaml` with the MSK bootstrap brokers, then:

```bash
helm upgrade --install rp-connect-timescaledb redpanda/connect \
  --namespace {DEPLOYMENT_ID} \
  -f helm/rp-connect-timescaledb.yaml
```

**7. Bootstrap RisingWave DDL**

```bash
kubectl port-forward -n {DEPLOYMENT_ID} svc/risingwave 4566:4566 &
psql -h localhost -p 4566 -U root \
  -v msk_username=workshop-{DEPLOYMENT_ID} \
  -v msk_password=<password> \
  -f risingwave/ddl-cloud.sql
```

**8. Wait for all pods**

```bash
kubectl get pods -n {DEPLOYMENT_ID}
kubectl get pods -n cnpg-system
kubectl get pods -n risingwave-system
```

All pods should reach `Running` within ~5 minutes of each deploy step.

---

## References

- [RisingWave Kubernetes Operator](https://docs.risingwave.com/deploy/risingwave-kubernetes)
- [CloudNativePG](https://cloudnative-pg.io/documentation/)
- [Redpanda Connect](https://docs.redpanda.com/redpanda-connect/)
