# Block 2 — Launch K3s Job + Sensor EC2 (Parallel)

**Duration:** 60 min

Launch both steps simultaneously — they run independently and must both complete before Block 3.

---

## Step 5A: IoT Job → K3s Cluster

!!! success "Your K3s cluster is already running"
    The facilitator pre-deploy (`scripts/sandbox.sh`) pre-warms the edge K3s
    cluster for every slot by launching this exact IoT Job during setup — so you
    don't burn ~20 min of session time watching K3s install. **This step is an
    inspection/demo of the fleet-execution mechanism**, not a wait. Confirm the
    cluster is up, then look at how it got there. (The commands below are still
    safe to re-run: `deploy-k3s.sh` is idempotent and no-ops on an existing
    install.)

Confirm the cluster server wrote its kubeconfig to Parameter Store:

```bash
aws ssm get-parameter \
  --name /workshop/ws-slot00/kubeconfig \
  --query "Parameter.Type" --output text
```
<!-- e2e:assert {"contains": "SecureString"} -->

Inspect the K3s bootstrap job the pre-deploy created and how each device fared:

```bash
aws iot list-jobs \
  --query "jobs[?starts_with(jobId,'ws-slot00-deploy-k3s')].[jobId,status]" \
  --output text
```
<!-- e2e:assert {"contains": "ws-slot00-deploy-k3s"} -->

### How the pre-warm launched it (reference)

The steps below are what `scripts/launch-k3s.sh` runs on your behalf — walk
through them to understand the IoT fleet-execution pattern.

1. Upload the job script to S3:

```bash
aws s3 cp job-scripts/deploy-k3s.sh \
  s3://workshop-platform-000000000000/job-scripts/ws-slot00/deploy-k3s.sh
```
<!-- e2e:assert {"contains": "upload:"} -->

2. Create an IoT Job targeting Thing Group:

    ```
    ws-slot00-devices
    ```

```json
{
  "version": "1.0",
  "steps": [
    {
      "action": {
        "name": "deploy-k3s",
        "type": "runHandler",
        "input": {
          "handler": "run-script.sh",
          "args": ["s3://workshop-platform-000000000000/job-scripts/ws-slot00/deploy-k3s.sh"]
        },
        "runAsUser": ""
      }
    }
  ]
}
```

   - In-progress timer: **45 minutes** (K3s install ≈ 10–20 min; 45 min gives a safe margin)
   - Device 1 handler: stands up the K3s server node, writes token + kubeconfig to SSM
   - Devices 2 & 3 handlers: poll SSM Parameter Store for the K3s server token, then join as agents

    Upload the job document and create the job:

    ```bash
    cat > /tmp/deploy-k3s-job-doc.json << 'EOF'
    {
      "version": "1.0",
      "steps": [
        {
          "action": {
            "name": "deploy-k3s",
            "type": "runHandler",
            "input": {
              "handler": "run-script.sh",
              "args": ["s3://workshop-platform-000000000000/job-scripts/ws-slot00/deploy-k3s.sh"]
            },
            "runAsUser": ""
          }
        }
      ]
    }
    EOF

    aws s3 cp /tmp/deploy-k3s-job-doc.json \
      s3://workshop-platform-000000000000/ws-slot00/job-docs/deploy-k3s-job-doc.json
    ```
    <!-- e2e:assert {"contains": "upload:"} -->

    ??? example "AWS CLI equivalent — create the K3s bootstrap job"
        ```bash
        JOB_ID="ws-slot00-deploy-k3s-$(date +%s)"
        aws iot create-job \
          --job-id "$JOB_ID" \
          --targets "$(aws iot describe-thing-group \
              --thing-group-name ws-slot00-devices \
              --query thingGroupArn --output text)" \
          --document-source \
              s3://workshop-platform-000000000000/ws-slot00/job-docs/deploy-k3s-job-doc.json \
          --timeout-config '{"inProgressTimeoutInMinutes":45}' \
          --output json
        ```
        <!-- e2e:assert {"jsonPath": "jobId", "matches": "deploy-k3s-\\d+$", "jobSucceeds": true, "jobTimeoutMinutes": 45} -->

3. Observe job status per device: `IN_PROGRESS` → `SUCCEEDED`

!!! info "Ordering without job dependencies"
    The handler scripts on devices 2 and 3 implement a poll-and-wait loop against SSM Parameter Store. Device 1 writes the K3s server token to Parameter Store after the server starts; devices 2 and 3 retry until the token appears. This achieves ordered startup without IoT Jobs having native step dependencies.

---

## Step 5B: Deploy Simulated Sensor EC2

A 4th EC2 instance (`workshop-ws-slot00-sensor-sim`) is already deployed by the CDK stack. It runs:
- **Mosquitto** — MQTT broker on port 1883, accessible within the edge subnet
- **`sensor-sim.py`** — Python simulator publishing to Mosquitto at 0.2–1 Hz

Simulated sensors:

| Sensor | Variable | Unit | Rate |
|---|---|---|---|
| Pump pressure (3× pump trucks) | `pump_pressure_1/2/3` | PSI | 1 Hz |
| Slurry flow rate | `slurry_flow_bpm` | BPM | 1 Hz |
| Blender RPM | `blender_rpm` | RPM | 1 Hz |
| Wellhead treating pressure | `wellhead_pressure` | PSI | 1 Hz |
| Proppant concentration | `proppant_conc_lb_gal` | lb/gal | 0.5 Hz |
| Annular pressure | `annular_pressure` | PSI | 1 Hz |
| Surface treating temperature | `surface_temp_f` | °F | 0.2 Hz |

Find the simulator private IP (you'll need it for the Helm values in Block 3):

```bash
aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=workshop-ws-slot00-sensor-sim" \
            "Name=instance-state-name,Values=running" \
  --query "Reservations[0].Instances[0].PrivateIpAddress" \
  --output text
```
<!-- e2e:assert {"notContains": "None"} -->

Update `helm/edge-stack-values.yaml` with this IP as the `mqtt.host` value before running Block 3.

---

## Reference

- [IoT Jobs timeout configuration](https://docs.aws.amazon.com/iot/latest/developerguide/jobs-configurations-details.html)
