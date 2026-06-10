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
  --secret-id AmazonMSK_workshop-{DEPLOYMENT_ID} \
  --query SecretString --output text | python3 -m json.tool

# Get MSK bootstrap brokers (SASL/SCRAM endpoint, port 9096)
MSK_CLUSTER_ARN=$(aws kafka list-clusters --region us-east-1 \
  --query "ClusterInfoList[?ClusterName=='workshop-{DEPLOYMENT_ID}-msk'].ClusterArn" \
  --output text)
aws kafka get-bootstrap-brokers \
  --cluster-arn "$MSK_CLUSTER_ARN" \
  --region us-east-1 \
  --query BootstrapBrokerStringSaslScram --output text
```

Create a Kubernetes Secret with these values (used by Redpanda Connect and RisingWave):

```bash
kubectl create namespace {DEPLOYMENT_ID}

MSK_PASS=$(aws secretsmanager get-secret-value \
  --secret-id AmazonMSK_workshop-{DEPLOYMENT_ID} \
  --query SecretString --output text | python3 -c 'import sys,json; print(json.load(sys.stdin)["password"])')
MSK_BOOTSTRAP=$(aws kafka get-bootstrap-brokers \
  --cluster-arn "$MSK_CLUSTER_ARN" --region us-east-1 \
  --query BootstrapBrokerStringSaslScram --output text)

kubectl create secret generic msk-credentials \
  --namespace {DEPLOYMENT_ID} \
  --from-literal=MSK_USERNAME=workshop-{DEPLOYMENT_ID} \
  --from-literal=MSK_PASSWORD="$MSK_PASS" \
  --from-literal=MSK_BOOTSTRAP_SERVERS="$MSK_BOOTSTRAP"
```

!!! warning "MSK auto-create topics is disabled"
    Create the sensor topics before running the DDL:
    ```bash
    # Run from a pod in the cluster (e.g. the kafkatools helper)
    # or use the AWS CLI kafka-topics wrapper if you have network access.
    # Topics needed: sensors.raw.sim, sensors.raw.{DEPLOYMENT_ID}-edge-0, etc.
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

RisingWave's PostgreSQL wire protocol is on port **4567** (the HTTP dashboard is 4560):

```bash
# Port-forward — keep running in a separate terminal
kubectl port-forward -n {DEPLOYMENT_ID} svc/risingwave-cloud-frontend 4567:4567 &

# Substitute credentials and apply
sed -e "s|__MSK_BOOTSTRAP__|$MSK_BOOTSTRAP|g" \
    -e "s|__MSK_USER__|workshop-{DEPLOYMENT_ID}|g" \
    -e "s|__MSK_PASS__|$MSK_PASS|g" \
    risingwave/ddl-cloud.sql | psql -h localhost -p 4567 -U root -d dev
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
