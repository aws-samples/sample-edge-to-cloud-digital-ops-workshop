# Block 2 — Create and Deploy an IoT Job

**Duration:** 60 min

The update does two things:

1. Changes publish frequency from 0.2 Hz → **1 Hz**
2. Adds **`net_io_bytes_sent`** and **`net_io_bytes_recv`** to the payload

---

## Steps

**1. Open `job-scripts/telemetry-v2.sh`** in your editor (or browse it on [GitHub](https://github.com/energy-digital-operations/edge-digital-operations-workshop/blob/main/job-scripts/telemetry-v2.sh)). Facilitator walks through the key sections:

- `TELEMETRY_INTERVAL_MS` changing from `5000` → `1000`
- The `METRICS` array extended with the two network metrics
- The `aws iot update-thing-shadow` call that reports `config_version: 2.0.0`
- The `exit 0` / `exit 1` contract

**2. Make the edits** directly in the IDE: change the interval and add the two network metrics to the array.

**3. Upload the edited script to S3:**

```bash
aws s3 cp job-scripts/telemetry-v2.sh \
  s3://workshop-{DEPLOYMENT_ID}/job-scripts/telemetry-v2.sh
```

**4. Create the IoT Job in the console:**

- Target: Thing Group `{DEPLOYMENT_ID}-devices`
- Job document:

```json
{
  "operation": "update-telemetry-config",
  "scriptUri": "s3://workshop-{DEPLOYMENT_ID}/job-scripts/telemetry-v2.sh",
  "version": "2.0.0"
}
```

**5. Configure rollout:**

- Max rate: **1 device/minute**
- Abort criteria: abort if **>33%** of devices fail

**6. Observe job status** per device: `IN_PROGRESS` → `SUCCEEDED`

**7. Return to the MQTT test client** and observe:

- Messages now arrive at **1 Hz**
- Payload includes `net_io_bytes_sent` and `net_io_bytes_recv`

---

## Discussion

- What does the staged rollout protect you against?
- What happens if a handler script times out without exiting?
- How would you roll back if the new script caused issues?

---

## Reference

- [IoT Jobs rollout configuration](https://docs.aws.amazon.com/iot/latest/developerguide/jobs-configurations-details.html)
