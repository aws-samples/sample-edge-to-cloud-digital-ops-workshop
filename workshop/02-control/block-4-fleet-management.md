# Block 3 — Fleet Management Deep Dive

**Duration:** 45 min

---

## Steps

**1. Navigate to [IoT Core → Software Package Catalog](https://console.aws.amazon.com/iot/home#/devicePackages)**

- Observe the pre-registered package `ws-slot00-telemetry-agent` with published versions `1.0.0`–`4.0.0` (created by the platform/participant stacks — no manual registration needed)
- Because the Session-2 job deployed version `2.0.0` with `--destination-package-versions`, IoT Jobs updated each device's reserved `$package` shadow to `telemetry-agent.version: 2.0.0` automatically on success — the catalog is the source of truth for what each device runs

??? example "AWS CLI equivalent"
    ```bash
    aws iot list-packages \
      --query 'packageSummaries[?contains(packageName, `ws-slot00`)]' \
      --output table
    ```
    <!-- e2e:assert {"contains": "ws-slot00"} -->

**2. Confirm all devices report a `config_version`** — and see which version each one runs:

Fleet Indexing keeps a queryable copy of every device's named shadow. Query it
from the CLI and format the result so you can read the reported version per
device — the console search only filters the thing list, it won't show you the
shadow values you actually care about here.

```bash
aws iot search-index --index-name AWS_Things \
  --query-string 'attributes.deploymentId:ws-slot00 AND shadow.name.device-config.reported.config_version:*' \
  --output json \
| python3 -c '
import sys, json
things = json.load(sys.stdin)["things"]
if not things:
    sys.exit("No devices report a config_version yet — wait for the job to finish.")
print("THING_NAME".ljust(40), "REPORTED config_version")
for t in things:
    reported = json.loads(t["shadow"])["name"]["device-config"]["reported"]
    print(t["thingName"].ljust(40), reported["config_version"])
'
```
<!-- e2e:assert {"contains": "REPORTED config_version", "notContains": "Traceback"} -->

> **Note:** The query matches any reported `config_version` rather than pinning
> `3.0.0` — later sessions push newer job versions to the same shared slot, so a
> fixed version would drift out of date. The table shows you the actual version
> each device converged on.

**3. Simulate configuration drift** — push a stale `desired` version to one device:

```bash
THING_NAME=$(aws iot list-things-in-thing-group \
  --thing-group-name ws-slot00-devices \
  --query 'things[0]' --output text)

# Save the device's current reported version so the drift can be reverted below.
aws iot-data get-thing-shadow \
  --thing-name "$THING_NAME" \
  --shadow-name device-config \
  --cli-binary-format raw-in-base64-out \
  /tmp/shadow-before.json > /dev/null
REPORTED_VERSION=$(python3 -c "import json; print(json.load(open('/tmp/shadow-before.json'))['state']['reported']['config_version'])")
echo "Selected device: $THING_NAME (currently reporting $REPORTED_VERSION)"

# Overwrite desired.config_version with an old value — reported still lags, so the device is now "drifted".
aws iot-data update-thing-shadow \
  --thing-name "$THING_NAME" \
  --shadow-name device-config \
  --cli-binary-format raw-in-base64-out \
  --payload '{"state":{"desired":{"config_version":"1.0.0"}}}' \
  /tmp/shadow-update-response.json
cat /tmp/shadow-update-response.json
```
<!-- e2e:assert {"contains": "version", "notContains": "Traceback"} -->

**4. Run a drift detection query** — find devices where `desired` ≠ `reported`, and see both values:

Fleet Indexing takes a few seconds to reflect the shadow update, so this polls
until the drifted device appears, then prints the desired-vs-reported gap per
device:

```bash
for _i in $(seq 1 12); do
  RESULT=$(aws iot search-index --index-name AWS_Things \
    --query-string 'attributes.deploymentId:ws-slot00 AND NOT (shadow.name.device-config.desired.config_version:shadow.name.device-config.reported.config_version)' \
    --output json)
  COUNT=$(echo "$RESULT" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['things']))")
  [ "$COUNT" != "0" ] && break
  sleep 15
done

echo "$RESULT" | python3 -c '
import sys, json
things = json.load(sys.stdin)["things"]
if not things:
    sys.exit("No drifted devices found.")
print("THING_NAME".ljust(40), "DESIRED".ljust(8), "REPORTED")
for t in things:
    cfg = json.loads(t["shadow"])["name"]["device-config"]
    desired = cfg.get("desired", {}).get("config_version", "-")
    reported = cfg.get("reported", {}).get("config_version", "-")
    print(t["thingName"].ljust(40), desired.ljust(8), reported)
'
```
<!-- e2e:assert {"contains": "1.0.0", "notContains": "Traceback"} -->

The device you edited appears with `DESIRED 1.0.0` alongside its (higher) `REPORTED` version — that mismatch is the drift.

**5. Revert the drift** — set `desired.config_version` back to the device's actual reported version so the shared slot is left converged for the next session:

```bash
aws iot-data update-thing-shadow \
  --thing-name "$THING_NAME" \
  --shadow-name device-config \
  --cli-binary-format raw-in-base64-out \
  --payload "{\"state\":{\"desired\":{\"config_version\":\"$REPORTED_VERSION\"}}}" \
  /tmp/shadow-revert-response.json
cat /tmp/shadow-revert-response.json
```
<!-- e2e:assert {"contains": "version"} -->

---

## Discussion

- This is how you find devices that haven't converged. How would you automate remediation?
- What is a Dynamic Thing Group, and how could you use drift detection as a group membership criterion?
- At what fleet size does manual console-based drift detection become infeasible?

---

## Reference

- [Software Package Catalog](https://docs.aws.amazon.com/iot/latest/developerguide/software-package-catalog.html)
