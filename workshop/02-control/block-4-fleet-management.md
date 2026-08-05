# Block 3 — Fleet Management Deep Dive

**Duration:** 45 min

---

## Steps

**1. Navigate to [IoT Core → Software Package Catalog](https://console.aws.amazon.com/iot/home#/devicePackages)**

- Observe the pre-registered package `ws-slot00-telemetry-agent` with published versions `1.0.0`–`4.0.0` (created by the platform/participant stacks — no manual registration needed)
- Because the Session-2 job deployed version `4.0.0` with `--destination-package-versions`, IoT Jobs updated each device's reserved `$package` shadow to `telemetry-agent.version: 4.0.0` automatically on success — the catalog is the source of truth for what each device runs

??? example "AWS CLI equivalent"
    ```bash
    aws iot list-packages \
      --query 'packageSummaries[?contains(packageName, `ws-slot00`)]' \
      --output table
    ```
    <!-- e2e:assert {"contains": "ws-slot00"} -->

**2. Run a Fleet Indexing query to confirm all devices report a `config_version`:**

[Open in console](https://us-east-1.console.aws.amazon.com/iot/home?region=us-east-1#/search?indexType=AWS_Things&search=attributes.deploymentId%3Aws-slot00%20AND%20shadow.name.device-config.reported.config_version%3A*){ .md-button target=_blank }

??? example "AWS CLI equivalent"
    ```bash
    aws iot search-index --index-name AWS_Things \
      --query-string 'attributes.deploymentId:ws-slot00 AND shadow.name.device-config.reported.config_version:*'
    ```
    <!-- e2e:assert {"jsonPath": "things[0].thingName", "matches": ".+"} -->

    > **Note:** The example above queries for any reported `config_version` rather
    > than pinning `2.0.0` — later sessions push newer job versions to the same
    > shared slot, so a fixed version would drift out of date. Swap in a specific
    > version to confirm a job rollout completed on your own deployment.

**3. Simulate configuration drift:**

- Navigate to **IoT Core → Manage → Things → (any device) → Shadows → device-config → Edit**
- Set `desired.config_version` back to `1.0.0` in the JSON editor

```bash
THING_NAME=$(aws iot list-things-in-thing-group \
  --thing-group-name ws-slot00-devices \
  --query 'things[0]' --output text)

# Save the device's current reported version so the drift can be reverted below.
REPORTED_VERSION=$(aws iot-data get-thing-shadow \
  --thing-name "$THING_NAME" \
  --shadow-name device-config \
  --cli-binary-format raw-in-base64-out \
  /tmp/shadow-before.json > /dev/null && \
  python3 -c "import json; print(json.load(open('/tmp/shadow-before.json'))['state']['reported']['config_version'])")
```
<!-- e2e:assert {"notContains": "Traceback"} -->

??? example "AWS CLI equivalent"
    ```bash
    aws iot-data update-thing-shadow \
      --thing-name "$THING_NAME" \
      --shadow-name device-config \
      --cli-binary-format raw-in-base64-out \
      --payload '{"state":{"desired":{"config_version":"1.0.0"}}}' \
      /tmp/shadow-update-response.json
    cat /tmp/shadow-update-response.json
    ```
    <!-- e2e:assert {"contains": "version"} -->

**4. Run a drift detection query** — find devices where desired ≠ reported:

[Open in console](https://us-east-1.console.aws.amazon.com/iot/home?region=us-east-1#/search?indexType=AWS_Things&search=attributes.deploymentId%3Aws-slot00%20AND%20NOT%20(shadow.name.device-config.desired.config_version%3Ashadow.name.device-config.reported.config_version)){ .md-button target=_blank }

??? example "AWS CLI equivalent"
    ```bash
    for _i in $(seq 1 12); do
      RESULT=$(aws iot search-index --index-name AWS_Things \
        --query-string 'attributes.deploymentId:ws-slot00 AND NOT (shadow.name.device-config.desired.config_version:shadow.name.device-config.reported.config_version)' \
        --output json)
      echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['things']))" | grep -qv '^0$' && break
      sleep 15
    done
    echo "$RESULT"
    ```
    <!-- e2e:assert {"jsonPath": "things[0].thingName", "matches": ".+"} -->

You should see the device you edited appear in the results.

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
