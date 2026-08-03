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
<!-- e2e:assert {"contains": "context"} -->

!!! info "Namespace-scoped access via IAM"
    Steps 4, 6, and 7 below (cert-manager, the RisingWave operator, the CNPG operator) are cluster-scoped installs — run once per cluster by whoever has cluster-admin access (the facilitator, or CI). If you're a participant without cluster-admin, your own operations (namespace `ws-slot00` only — Steps 2, 3, 5, 8, 9) work via `WorkshopParticipantRole-ws-slot00`, an IAM role with an EKS access entry scoped to just your namespace: run `aws eks update-kubeconfig --region us-east-1 --name workshop-eks --role-arn arn:aws:iam::000000000000:role/WorkshopParticipantRole-ws-slot00` instead, once your admin has granted your IAM identity `sts:AssumeRole` on that role.

Confirm nodes are Ready:

```bash
kubectl get nodes
```
<!-- e2e:assert {"contains": "Ready", "persona": "admin"} -->

!!! info "Default StorageClass (cluster-scoped, run once)"
    The platform stack installs the EBS CSI driver, but the cluster ships with
    no *default* `StorageClass` — so a PersistentVolumeClaim that doesn't name
    one (TimescaleDB, RisingWave) stays `Pending` forever. Create a CSI-backed
    `gp3` default once per cluster (facilitator/CI):

    ```bash
    kubectl apply -f - <<'EOF'
    apiVersion: storage.k8s.io/v1
    kind: StorageClass
    metadata:
      name: gp3
      annotations:
        storageclass.kubernetes.io/is-default-class: "true"
    provisioner: ebs.csi.aws.com
    volumeBindingMode: WaitForFirstConsumer
    allowVolumeExpansion: true
    parameters:
      type: gp3
      encrypted: "true"
    EOF
    ```
    <!-- e2e:assert {"contains": "storageclass.storage.k8s.io/gp3", "persona": "admin"} -->

**2. Add Helm repos**

```bash
helm repo add risingwavelabs https://risingwavelabs.github.io/helm-charts
helm repo add redpanda https://charts.redpanda.com
helm repo add cloudnative-pg https://cloudnative-pg.github.io/charts
helm repo update
```
<!-- e2e:assert {"contains": "Update Complete"} -->

**3. Retrieve MSK credentials**

```bash
# Get the auto-generated MSK password from Secrets Manager
aws secretsmanager get-secret-value \
  --secret-id AmazonMSK_workshop-ws-slot00 \
  --query SecretString --output text | python3 -m json.tool

# Get MSK bootstrap brokers (SASL/SCRAM endpoint, port 9096)
MSK_CLUSTER_ARN=$(aws cloudformation list-exports \
  --query "Exports[?Name=='workshop-platform-msk-arn'].Value" \
  --output text)
aws kafka get-bootstrap-brokers \
  --cluster-arn "$MSK_CLUSTER_ARN" \
  --region us-east-1 \
  --query BootstrapBrokerStringSaslScram --output text
```
<!-- e2e:assert {"contains": ":9096"} -->

Create a Kubernetes Secret with these values (used by Redpanda Connect and RisingWave):

```bash
kubectl create namespace ws-slot00 --dry-run=client -o yaml | kubectl apply -f -

MSK_PASS=$(aws secretsmanager get-secret-value \
  --secret-id AmazonMSK_workshop-ws-slot00 \
  --query SecretString --output text | python3 -c 'import sys,json; print(json.load(sys.stdin)["password"])')
MSK_BOOTSTRAP=$(aws kafka get-bootstrap-brokers \
  --cluster-arn "$(aws cloudformation list-exports --query "Exports[?Name=='workshop-platform-msk-arn'].Value" --output text)" \
  --region us-east-1 \
  --query BootstrapBrokerStringSaslScram --output text)

kubectl create secret generic msk-credentials \
  --namespace ws-slot00 \
  --from-literal=MSK_USERNAME=workshop-ws-slot00 \
  --from-literal=MSK_PASSWORD="$MSK_PASS" \
  --from-literal=MSK_BOOTSTRAP_SERVERS="$MSK_BOOTSTRAP" \
  --dry-run=client -o yaml | kubectl apply -f -
```
<!-- e2e:assert {"contains": "secret/msk-credentials"} -->

!!! warning "MSK auto-create topics is disabled — and MSK is VPC-private"
    Create the sensor topics before running the DDL. **The shared MSK cluster has
    no public endpoint** (`PublicAccess: DISABLED`), so `create-msk-topics.sh` only
    works from a host *inside* the workshop VPC — running it from your laptop will
    hang and time out reaching the brokers on `:9096`.

    Run it from the EKS cluster itself, using a throwaway pod that already sits on
    the cluster's pod network (which routes to MSK). This needs only your existing
    `kubectl` access — no VPC bastion. We use a small Python image with
    `kafka-python` rather than the JVM Kafka CLI: the admin JVM's default heap can
    OOM on the workshop's memory-constrained nodes, whereas the Python client is
    light enough to run reliably.

    ```bash
    MSK_BOOTSTRAP=$(aws kafka get-bootstrap-brokers \
      --cluster-arn "$(aws cloudformation list-exports \
        --query "Exports[?Name=='workshop-platform-msk-arn'].Value" --output text)" \
      --region us-east-1 --query BootstrapBrokerStringSaslScram --output text)
    MSK_PASS=$(aws secretsmanager get-secret-value \
      --secret-id AmazonMSK_workshop-ws-slot00 \
      --query SecretString --output text | python3 -c 'import sys,json; print(json.load(sys.stdin)["password"])')

    kubectl -n ws-slot00 delete pod kafka-admin --ignore-not-found
    kubectl -n ws-slot00 run kafka-admin --restart=Never --image=python:3.12-slim \
      --command -- sleep 900
    kubectl -n ws-slot00 wait --for=condition=Ready pod/kafka-admin --timeout=120s
    kubectl -n ws-slot00 exec kafka-admin -- pip install --quiet kafka-python

    kubectl -n ws-slot00 exec -i kafka-admin -- \
      env MSK_BOOTSTRAP="$MSK_BOOTSTRAP" MSK_USER="workshop-ws-slot00" MSK_PASS="$MSK_PASS" python3 - <<'PYEOF'
    import os
    from kafka.admin import KafkaAdminClient, NewTopic
    from kafka.errors import TopicAlreadyExistsError
    admin = KafkaAdminClient(
        bootstrap_servers=os.environ["MSK_BOOTSTRAP"].split(","),
        security_protocol="SASL_SSL", sasl_mechanism="SCRAM-SHA-512",
        sasl_plain_username=os.environ["MSK_USER"], sasl_plain_password=os.environ["MSK_PASS"])
    for t in ["sensors.raw.sim", "raw.telemetry",
              "sensors.raw.ws-slot00-edge-0", "sensors.raw.ws-slot00-edge-1", "sensors.raw.ws-slot00-edge-2"]:
        try:
            admin.create_topics([NewTopic(name=t, num_partitions=3, replication_factor=2)])
            print("created", t)
        except TopicAlreadyExistsError:
            print("exists", t)
    print("TOPICS:", sorted(admin.list_topics()))
    PYEOF
    kubectl -n ws-slot00 delete pod kafka-admin
    ```
    <!-- e2e:assert {"contains": "sensors.raw.sim"} -->

    Topics created (creating an existing topic is a no-op — safe to re-run):

    | Topic | Purpose |
    |-------|---------|
    | `sensors.raw.sim` | Edge Redpanda → MSK relay (simulator) |
    | `sensors.raw.ws-slot00-edge-0` | Per-node relay — edge 0 |
    | `sensors.raw.ws-slot00-edge-1` | Per-node relay — edge 1 |
    | `sensors.raw.ws-slot00-edge-2` | Per-node relay — edge 2 |
    | `raw.telemetry` | IoT Rule → MSK (system metrics) |

    !!! tip "From a VPC host instead?"
        If you have shell on an EC2 instance inside the workshop VPC, you can run
        `scripts/create-msk-topics.sh --deployment-id ws-slot00` there directly — it
        prefers `kafka-topics.sh` on PATH and otherwise falls back to the same
        bundled `kafka-python` implementation.

**4. Install cert-manager**

The RisingWave operator's CRDs use `cert-manager`-issued webhook certificates — install it once per cluster if not already present:

```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml

kubectl wait --for=condition=Established \
  crd/certificates.cert-manager.io crd/issuers.cert-manager.io \
  --timeout=120s
```
<!-- e2e:assert {"contains": "condition met", "persona": "admin"} -->

**5. Create the RisingWave S3 state bucket and service account**

Each participant slot gets its own S3 bucket for RisingWave's state store, and a Kubernetes ServiceAccount annotated for IRSA so RisingWave pods can read/write it without static credentials. The `workshop-risingwave-s3-v2` IAM role (trusting any `risingwave-cloud` service account cluster-wide) is created once by `WorkshopPlatformStack`:

```bash
aws s3api head-bucket --bucket workshop-ws-slot00-000000000000-risingwave-state 2>/dev/null || \
  aws s3 mb s3://workshop-ws-slot00-000000000000-risingwave-state --region us-east-1

kubectl create serviceaccount risingwave-cloud \
  --namespace ws-slot00 --dry-run=client -o yaml | \
  kubectl annotate -f - --local -o yaml \
    eks.amazonaws.com/role-arn=arn:aws:iam::000000000000:role/workshop-risingwave-s3-v2 | \
  kubectl apply -f -
```
<!-- e2e:assert {"contains": "serviceaccount/risingwave-cloud"} -->

**6. Deploy RisingWave operator and instance**

The RisingWave operator is cluster-scoped and shared — install it once into `risingwave-system` if not already present:

```bash
helm upgrade --install risingwave-operator risingwavelabs/risingwave-operator \
  --namespace risingwave-system --create-namespace \
  -f helm/risingwave-values.yaml

# Wait for operator
kubectl wait --for=condition=available deployment/risingwave-operator \
  -n risingwave-system --timeout=120s

# Deploy the RisingWave CR into your participant namespace
sed -e "s/\${DEPLOYMENT_ID}/ws-slot00/g" -e "s/\${ACCOUNT_ID}/000000000000/g" \
  k8s/risingwave-cloud.yaml | kubectl apply -n ws-slot00 -f -
```
<!-- e2e:assert {"contains": "risingwave-cloud", "persona": "admin"} -->

!!! warning "Service account must exist first"
    The RisingWave CR references `serviceAccountName: risingwave-cloud` (Step 5) — apply the CR only after the service account exists, or the pods will fail to schedule.

**7. Deploy TimescaleDB via CloudNativePG**

The CNPG operator is cluster-scoped and shared — install once into `cnpg-system` if not already present:

```bash
helm upgrade --install cnpg cloudnative-pg/cloudnative-pg \
  --namespace cnpg-system --create-namespace

# Wait for operator
kubectl wait --for=condition=available deployment/cnpg-cloudnative-pg \
  -n cnpg-system --timeout=120s

kubectl apply -f k8s/timescaledb-cloud-cluster.yaml -n ws-slot00
```
<!-- e2e:assert {"contains": "timescaledb-cloud", "persona": "admin"} -->

Wait for CNPG to initialize the cluster and generate the `timescaledb-cloud-app` credentials Secret:

```bash
kubectl wait --for=condition=Ready pod \
  -l cnpg.io/cluster=timescaledb-cloud -n ws-slot00 --timeout=300s
```
<!-- e2e:assert {"contains": "condition met"} -->

**8. Deploy Redpanda Connect (MSK → TimescaleDB)**

Create the `timescaledb-credentials` Secret from the password CNPG generated, then install the chart — the MSK bootstrap brokers come from the `msk-credentials` Secret created in Step 3, referenced via `envFrom` in `helm/rp-connect-timescaledb.yaml`:

```bash
TSDB_PASS=$(kubectl get secret timescaledb-cloud-app -n ws-slot00 \
  -o jsonpath='{.data.password}' | base64 -d)

kubectl create secret generic timescaledb-credentials \
  --namespace ws-slot00 \
  --from-literal=TIMESCALE_DSN="postgres://workshop:${TSDB_PASS}@timescaledb-cloud-rw.ws-slot00.svc:5432/edge" \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install rp-connect-timescaledb redpanda/connect \
  --namespace ws-slot00 \
  -f helm/rp-connect-timescaledb.yaml
```
<!-- e2e:assert {"contains": "rp-connect-timescaledb"} -->

**9. Bootstrap RisingWave DDL**

RisingWave's PostgreSQL wire protocol is on port **4567** (the HTTP dashboard is 4560):

```bash
kubectl rollout status deployment/risingwave-cloud-frontend-default -n ws-slot00 --timeout=300s

# Port-forward — keep running in a separate terminal
kubectl port-forward -n ws-slot00 svc/risingwave-cloud-frontend 4567:4567 > /tmp/risingwave-cloud-pf.log 2>&1 &
RW_PF_PID=$!
# Wait for the forward to bind (kubectl logs "Forwarding from") rather than
# racing a fixed sleep against a slow control plane.
until grep -q "Forwarding from" /tmp/risingwave-cloud-pf.log 2>/dev/null; do sleep 1; done

# Substitute credentials and apply
sed -e "s|__MSK_BOOTSTRAP__|$MSK_BOOTSTRAP|g" \
    -e "s|__MSK_USER__|workshop-ws-slot00|g" \
    -e "s|__MSK_PASS__|$MSK_PASS|g" \
    risingwave/ddl-cloud.sql | psql -h localhost -p 4567 -U root -d dev

# Stop the background port-forward once the DDL has applied
kill "$RW_PF_PID" 2>/dev/null || true
```
<!-- e2e:assert {"contains": "CREATE_MATERIALIZED_VIEW"} -->

**10. Wait for all pods**

```bash
kubectl get pods -n ws-slot00
kubectl get pods -n cnpg-system
kubectl get pods -n risingwave-system
```
<!-- e2e:assert {"contains": "NAME", "persona": "admin"} -->

All pods should reach `Running` within ~5 minutes of each deploy step.

---

## References

- [RisingWave Kubernetes Operator](https://docs.risingwave.com/deploy/risingwave-kubernetes)
- [CloudNativePG](https://cloudnative-pg.io/documentation/)
- [Redpanda Connect](https://docs.redpanda.com/redpanda-connect/)
