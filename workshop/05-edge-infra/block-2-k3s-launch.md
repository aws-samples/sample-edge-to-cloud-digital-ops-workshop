# Block 2 — Launch K3s Job + Sensor EC2 (Parallel)

**Duration:** 60 min

Launch both steps simultaneously — they run independently and must both complete before Block 3.

---

## Step 5A: IoT Job → K3s Cluster

1. Create an IoT Job targeting Thing Group `{DEPLOYMENT_ID}-devices`:
   - Job document: `deploy-k3s-v1`
   - In-progress timer: **45 minutes** (K3s install ≈ 10–20 min; 45 min gives a safe margin)
   - Device 1 handler: stands up the K3s server node
   - Devices 2 & 3 handlers: poll SSM Parameter Store for the K3s server token, then join as agents

2. Observe job status per device: `IN_PROGRESS` → `SUCCEEDED`

!!! info "Ordering without job dependencies"
    The handler scripts on devices 2 and 3 implement a poll-and-wait loop against SSM Parameter Store. Device 1 writes the K3s server token to Parameter Store after the server starts; devices 2 and 3 retry until the token appears. This achieves ordered startup without IoT Jobs having native step dependencies.

---

## Step 5B: Deploy Simulated Sensor EC2

A 4th EC2 instance (`t3.medium`) is deployed into the `workshop-edge` VPC subnet. Its user data runs a Python simulator publishing to the edge MQTT broker.

Simulated sensors:

| Sensor | Unit | Rate |
|---|---|---|
| Pump pressure (3× pump trucks) | PSI | 1 Hz |
| Slurry flow rate | BPM | 1 Hz |
| Blender RPM | — | 1 Hz |
| Wellhead treating pressure | PSI | 1 Hz |
| Proppant concentration | lb/gal | 0.5 Hz |
| Annular pressure | PSI | 1 Hz |
| Surface treating temperature | °F | 0.2 Hz |

!!! note
    The sensor EC2 will start publishing after the Helm deployment in Block 3 wires up the MQTT broker.

---

## Reference

- [IoT Jobs timeout configuration](https://docs.aws.amazon.com/iot/latest/developerguide/jobs-configurations-details.html)
