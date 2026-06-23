# Block 2 — Create and Deploy an IoT Job

**Duration:** 60 min

The telemetry agent currently reports integer values for CPU, memory, and disk (`cpu_pct: 42`). The job deploys an updated agent that reports **3-decimal-place precision** (`cpu_pct: 42.150`) — important for detecting subtle trends in the analytics tier.

---

## Steps

**1. Open `job-scripts/telemetry-v3.sh`** in your editor. Find the three measurement lines inside the `while true` loop — they currently use integer formatting:

```bash
CPU=$(top -bn1 | grep "Cpu(s)" | awk '{printf "%d", $2+0}')
MEM=$(free | awk '/Mem:/ {printf "%d", $3/$2*100}')
DISK=$(df / | awk 'NR==2 {printf "%d", $5+0}')
```

Change `%d` to `%.3f` on all three lines so the agent emits floating-point values:

```bash
CPU=$(top -bn1 | grep "Cpu(s)" | awk '{printf "%.3f", $2+0}')
MEM=$(free | awk '/Mem:/ {printf "%.3f", $3/$2*100}')
DISK=$(df / | awk 'NR==2 {printf "%.3f", $5+0}')
```

The `%d` format truncates — `42.7%` becomes `42`. The `%.3f` format preserves three decimal places — `42.7%` becomes `42.700`. This matters for analytics: integer CPU values cluster at round numbers and make it hard to detect gradual drift.

Also note the `exit 0` at the end of the script — this is the contract with the IoT Jobs agent. `0` reports `SUCCEEDED`; any non-zero exit reports `FAILED` and triggers the abort criteria.

??? example "View source — `job-scripts/telemetry-v3.sh`"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/job-scripts/telemetry-v3.sh){ .md-button target=_blank }

    ```bash
    --8<-- "job-scripts/telemetry-v3.sh:job-handler"
    ```

**2. Upload the script and job document to S3:**

```bash
aws s3 cp job-scripts/telemetry-v3.sh \
  s3://workshop-shared-v2-000000000000/ws-slot00/job-scripts/telemetry-v3.sh
```

```bash
cat > /tmp/telemetry-v3-job-doc.json << 'EOF'
{
  "version": "1.0",
  "steps": [
    {
      "action": {
        "name": "update-telemetry-precision",
        "type": "runHandler",
        "input": {
          "handler": "run-script.sh",
          "args": ["s3://workshop-shared-v2-000000000000/ws-slot00/job-scripts/telemetry-v3.sh"]
        },
        "runAsUser": ""
      }
    }
  ]
}
EOF

aws s3 cp /tmp/telemetry-v3-job-doc.json \
  s3://workshop-shared-v2-000000000000/ws-slot00/job-docs/telemetry-v3-job-doc.json
```

**3. [Create the IoT Job in the console](https://us-east-1.console.aws.amazon.com/iot/home#/jobhub):**

- Job type: **Create custom job**
- **Thing groups to run this job:**

    ```
    ws-slot00-devices
    ```
- **Job document:** select **From file**, then paste the S3 URL:

    ```
    s3://workshop-shared-v2-000000000000/ws-slot00/job-docs/telemetry-v3-job-doc.json
    ```

**4. Configure rollout:**

- Max rate: **1 device/minute**
- Abort criteria: abort if **>33%** of devices fail

**5. Observe job status** per device: `IN_PROGRESS` → `SUCCEEDED`

**6. Return to the MQTT test client** and observe:

- Metric values now have 3 decimal places: `"cpu_pct": 12.450` instead of `"cpu_pct": 12`

---

## Discussion

- What does the staged rollout protect you against?
- What happens if a handler script times out without exiting?
- How would you roll back if the precision change caused downstream issues?

---

## Reference

- [IoT Jobs rollout configuration](https://docs.aws.amazon.com/iot/latest/developerguide/jobs-configurations-details.html)
