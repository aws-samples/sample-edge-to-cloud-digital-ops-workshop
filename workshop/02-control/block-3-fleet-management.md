# Block 3 — Fleet Management Deep Dive

**Duration:** 45 min

---

## Steps

**1. Navigate to IoT Core → Software Package Catalog**

- Register package: `telemetry-agent`
- Add versions `1.0.0` and `2.0.0`
- The job handler script automatically tags each device with `package_version=2.0.0` via `UpdateThingShadow`

**2. Run a Fleet Indexing query to confirm all devices report `2.0.0`:**

```
shadow.name.device-config.reported.config_version:2.0.0
```

**3. Simulate configuration drift:**

- Manually edit one device's shadow desired state back to `1.0.0` in the console

**4. Run a drift detection query:**

```
NOT (shadow.name.device-config.desired.config_version:shadow.name.device-config.reported.config_version)
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
