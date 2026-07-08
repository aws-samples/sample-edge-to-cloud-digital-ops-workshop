# Block 2 — Create and Deploy an IoT Job

**Duration:** 60 min

The telemetry agent currently reports integer values for CPU, memory, and disk (`cpu_pct: 42`). The job deploys an updated agent that reports **3-decimal-place precision** (`cpu_pct: 42.150`) — important for detecting subtle trends in the analytics tier.

---

## Steps

**1. Create `job-scripts/telemetry-v4.sh`** — a copy of `telemetry-v3.sh` with the precision fix applied. You can open `telemetry-v3.sh` in your editor and save a modified copy as `telemetry-v4.sh`, or run this command to create it in one step:

```bash
sed 's/%d/%.3f/g; s/3\.0\.0/4.0.0/g; s/telemetry-v3/telemetry-v4/g' \
  job-scripts/telemetry-v3.sh > job-scripts/telemetry-v4.sh && \
chmod +x job-scripts/telemetry-v4.sh && \
ls job-scripts/telemetry-v4.sh
```
<!-- e2e:assert {"contains": "telemetry-v4.sh"} -->

The three measurement lines inside the `while true` loop change from integer to 3-decimal precision:

```bash
# Before
CPU=$(top -bn1 | grep "Cpu(s)" | awk '{printf "%d", $2+0}')
MEM=$(free | awk '/Mem:/ {printf "%d", $3/$2*100}')
DISK=$(df / | awk 'NR==2 {printf "%d", $5+0}')
```
<!-- e2e:skip --><!-- illustrative diff snippet, not a runnable command -->

```bash
# After
CPU=$(top -bn1 | grep "Cpu(s)" | awk '{printf "%.3f", $2+0}')
MEM=$(free | awk '/Mem:/ {printf "%.3f", $3/$2*100}')
DISK=$(df / | awk 'NR==2 {printf "%.3f", $5+0}')
```
<!-- e2e:skip --><!-- illustrative diff snippet, not a runnable command -->

The `%d` format truncates — `42.7%` becomes `42`. The `%.3f` format preserves three decimal places — `42.7%` becomes `42.700`. This matters for analytics: integer CPU values cluster at round numbers and make it hard to detect gradual drift.

Also note the `exit 0` at the end of the script — this is the contract with the IoT Jobs agent. `0` reports `SUCCEEDED`; any non-zero exit reports `FAILED` and triggers the abort criteria.

??? example "View source — `job-scripts/telemetry-v3.sh` (starting point)"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/job-scripts/telemetry-v3.sh){ .md-button target=_blank }

    ```bash
    --8<-- "job-scripts/telemetry-v3.sh:job-handler"
    ```
    <!-- e2e:skip --><!-- MkDocs snippet include, not a runnable command -->

**2. Upload the script and job document to S3:**

```bash
aws s3 cp job-scripts/telemetry-v4.sh \
  s3://workshop-platform-000000000000/job-scripts/ws-slot00/telemetry-v4.sh
```
<!-- e2e:assert {"contains": "upload:"} -->

```bash
cat > /tmp/telemetry-v4-job-doc.json << 'EOF'
{
  "version": "1.0",
  "steps": [
    {
      "action": {
        "name": "update-telemetry-precision",
        "type": "runHandler",
        "input": {
          "handler": "run-script.sh",
          "args": ["s3://workshop-platform-000000000000/job-scripts/ws-slot00/telemetry-v4.sh"]
        },
        "runAsUser": ""
      }
    }
  ]
}
EOF

aws s3 cp /tmp/telemetry-v4-job-doc.json \
  s3://workshop-platform-000000000000/ws-slot00/job-docs/telemetry-v4-job-doc.json
```
<!-- e2e:assert {"contains": "upload:"} -->

**3. [Create the IoT Job in the console](https://us-east-1.console.aws.amazon.com/iot/home#/jobhub):**

- Job type: **Create custom job**
- **Thing groups to run this job:**

    ```
    ws-slot00-devices
    ```
- **Job document:** select **From S3**, then paste the S3 URL:

    ```
    s3://workshop-platform-000000000000/ws-slot00/job-docs/telemetry-v4-job-doc.json
    ```

- **Rollout:** Max rate **1 device/minute**
- **Abort criteria:** abort if **>33%** of devices fail

??? example "AWS CLI equivalent"
    ```bash
    JOB_ID="ws-slot00-telemetry-v4-$(date +%s)"
    aws iot create-job \
      --job-id "$JOB_ID" \
      --targets "$(aws iot describe-thing-group \
          --thing-group-name ws-slot00-devices \
          --query thingGroupArn --output text)" \
      --document-source \
          s3://workshop-platform-000000000000/ws-slot00/job-docs/telemetry-v4-job-doc.json \
      --job-executions-rollout-config \
          '{"maximumPerMinute":1}' \
      --abort-config \
          '{"criteriaList":[{"failureType":"ALL","action":"CANCEL","thresholdPercentage":33,"minNumberOfExecutedThings":1}]}' \
      --timeout-config '{"inProgressTimeoutInMinutes":15}' \
      --output json
    ```
    <!-- e2e:assert {"jsonPath": "jobId", "matches": "telemetry-v4-\\d+$", "jobSucceeds": true} -->

**4. Observe job status** per device: `IN_PROGRESS` → `SUCCEEDED`

Monitor from the console at [IoT Core → Manage → Jobs](https://us-east-1.console.aws.amazon.com/iot/home#/jobhub), or poll with the CLI:

```bash
aws iot list-job-executions-for-job \
  --job-id "$JOB_ID" \
  --query 'executionSummaries[].{thing:thingArn,status:jobExecutionSummary.status}' \
  --output table
```
<!-- e2e:skip --><!-- manual poll for console users; the CLI-equivalent block above already asserts jobSucceeds -->

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
