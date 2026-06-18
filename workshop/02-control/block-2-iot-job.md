# Block 2 — Create and Deploy an IoT Job

**Duration:** 60 min

The update does two things:

1. Changes publish frequency from 0.2 Hz → **1 Hz**
2. Adds **`net_io_bytes_sent`** and **`net_io_bytes_recv`** to the payload

---

## Steps

**1. Open `job-scripts/telemetry-v2.sh`** in your editor (or browse it on [GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/job-scripts/telemetry-v2.sh)). Facilitator walks through the key sections:

- `sleep 1` at the bottom of the loop (down from 5 s → 1 Hz)
- The network delta block: reads `/proc/net/dev`, computes `NET_IO_BYTES_SENT` / `NET_IO_BYTES_RECV` each cycle
- The `aws iot-data update-thing-shadow` call that reports `telemetry_interval_ms: 1000`, the full metrics list, and `config_version: "2.0.0"`
- The `exit 0` / `exit 1` contract

**2. Make the edits** directly in the IDE: change the interval and add the two network metrics to the array.

??? example "View source — `job-scripts/telemetry-v2.sh`"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/job-scripts/telemetry-v2.sh){ .md-button target=_blank }

    ```bash
    --8<-- "job-scripts/telemetry-v2.sh:job-handler"
    ```

**3. Upload the edited script and job document to S3:**

```bash
aws s3 cp job-scripts/telemetry-v2.sh \
  s3://workshop-ws-slot00-000000000000/job-scripts/telemetry-v2.sh
```

The console also requires the job document to be stored in S3. Create and upload it now:

```bash
cat > /tmp/telemetry-v2-job-doc.json << 'EOF'
{
  "version": "1.0",
  "steps": [
    {
      "action": {
        "name": "update-telemetry-config",
        "type": "runHandler",
        "input": {
          "handler": "run-script.sh",
          "args": ["s3://workshop-ws-slot00-000000000000/job-scripts/telemetry-v2.sh"]
        },
        "runAsUser": ""
      }
    }
  ]
}
EOF

aws s3 cp /tmp/telemetry-v2-job-doc.json \
  s3://workshop-ws-slot00-000000000000/job-docs/telemetry-v2-job-doc.json
```

The `run-script.sh` handler receives the S3 URI as `$2` and downloads it to run locally.

**4. [Create the IoT Job in the console](https://us-east-1.console.aws.amazon.com/iot/home#/jobhub):**

- Job type: **Create custom job**
- **Thing groups to run this job:** `{DEPLOYMENT_ID}-devices`
- **Job document:** select **From file**, then paste the S3 URL:
  `s3://workshop-ws-slot00-000000000000/job-docs/telemetry-v2-job-doc.json`

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
