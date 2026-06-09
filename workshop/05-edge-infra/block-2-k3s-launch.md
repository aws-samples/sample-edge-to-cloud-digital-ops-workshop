# Block 2 — Launch K3s Job + Sensor EC2 (Parallel)

**Duration:** 60 min

Launch both steps simultaneously — they run independently and must both complete before Block 3.

---

## Step 5A: IoT Job → K3s Cluster

1. Upload the job script to S3:

```bash
aws s3 cp job-scripts/deploy-k3s.sh \
  s3://workshop-{DEPLOYMENT_ID}/job-scripts/deploy-k3s.sh
```

2. Create an IoT Job targeting Thing Group `{DEPLOYMENT_ID}-devices`:

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
          "args": ["s3://workshop-{DEPLOYMENT_ID}/job-scripts/deploy-k3s.sh"]
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

3. Observe job status per device: `IN_PROGRESS` → `SUCCEEDED`

!!! info "Ordering without job dependencies"
    The handler scripts on devices 2 and 3 implement a poll-and-wait loop against SSM Parameter Store. Device 1 writes the K3s server token to Parameter Store after the server starts; devices 2 and 3 retry until the token appears. This achieves ordered startup without IoT Jobs having native step dependencies.

---

## Step 5B: Deploy Simulated Sensor EC2

A 4th EC2 instance (`workshop-{DEPLOYMENT_ID}-sensor-sim`) is already deployed by the CDK stack. It runs:
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
  --filters "Name=tag:Name,Values=workshop-{DEPLOYMENT_ID}-sensor-sim" \
            "Name=instance-state-name,Values=running" \
  --query "Reservations[0].Instances[0].PrivateIpAddress" \
  --output text
```

Update `helm/edge-stack-values.yaml` with this IP as the `mqtt.host` value before running Block 3.

---

## Reference

- [IoT Jobs timeout configuration](https://docs.aws.amazon.com/iot/latest/developerguide/jobs-configurations-details.html)
