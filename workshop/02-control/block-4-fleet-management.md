# Block 3 — Fleet Management Deep Dive

**Duration:** 45 min

---

## Steps

**1. Inspect the pre-registered software package:**

```bash
aws iot list-software-packages \
  --query 'packageList[?contains(packageName, `ws-slot00`)]' \
  --output table
```

The package `ws-slot00-telemetry-agent` is pre-registered by the platform stack with versions `1.0.0` and `2.0.0`. The `telemetry-v2.sh` job handler updates each device's `$package` shadow with `version: 2.0.0` after it runs successfully.

??? tip "Console alternative"
    [Open Software Package Catalog](https://console.aws.amazon.com/iot/home#/softwarepackagecatalog){ .md-button target=_blank }

**2. Run a Fleet Indexing query to confirm all devices report `2.0.0`:**

[Open in console](https://us-east-1.console.aws.amazon.com/iot/home?region=us-east-1#/search?indexType=AWS_Things&search=shadow.name.device-config.reported.config_version%3A2.0.0){ .md-button target=_blank }

```bash
aws iot search-index --index-name AWS_Things \
  --query-string 'attributes.deploymentId:ws-slot00 AND shadow.name.device-config.reported.config_version:2.0.0'
```

**3. Simulate configuration drift** — set one device's desired `config_version` back to `1.0.0`:

```bash
THING_NAME=$(aws iot list-things-in-thing-group \
  --thing-group-name ws-slot00-devices \
  --query 'things[0]' --output text)

aws iot-data update-thing-shadow \
  --thing-name "$THING_NAME" \
  --shadow-name device-config \
  --payload '{"state":{"desired":{"config_version":"1.0.0"}}}' \
  /dev/stdout
```

??? tip "Console alternative"
    **IoT Core → Manage → Things → (device) → Shadows → device-config → Edit** and set `desired.config_version` to `1.0.0`.

**4. Run a drift detection query** — find devices where desired ≠ reported:

[Open in console](https://us-east-1.console.aws.amazon.com/iot/home?region=us-east-1#/search?indexType=AWS_Things&search=NOT%20(shadow.name.device-config.desired.config_version%3Ashadow.name.device-config.reported.config_version)){ .md-button target=_blank }

```bash
aws iot search-index --index-name AWS_Things \
  --query-string 'attributes.deploymentId:ws-slot00 AND NOT (shadow.name.device-config.desired.config_version:shadow.name.device-config.reported.config_version)'
```

You should see the device you edited appear in the results.

---

## Discussion

- This is how you find devices that haven't converged. How would you automate remediation?
- What is a Dynamic Thing Group, and how could you use drift detection as a group membership criterion?
- At what fleet size does manual console-based drift detection become infeasible?

---

## Reference

- [Software Package Catalog](https://docs.aws.amazon.com/iot/latest/developerguide/software-package-catalog.html)
