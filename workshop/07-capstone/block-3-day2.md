# Block 3 — Day-2 Operations Scenario

**Duration:** 60 min

---

## Final IoT Job: Target a Dynamic Thing Group

Simulate a production Day-2 scenario: find and update all devices still on the old 0.2 Hz config.

**1. Create a Dynamic Thing Group targeting devices that haven't been updated:**

```
shadow.name.device-config.reported.telemetry_interval_ms:[4000 TO *]
```

**2. Create an IoT Job targeting this Dynamic Thing Group:**

- Job: update to 1 Hz (`telemetry_interval_ms: 1000`)
- Rollout: max 2 devices/minute
- Abort criteria: >33% failure rate

**3. Observe staged rollout** with the abort criteria in action:

- Navigate to **IoT Core → Manage → Jobs → (job)**
- Watch each device progress: `QUEUED` → `IN_PROGRESS` → `SUCCEEDED`
- Confirm Fleet Indexing query returns zero devices after completion:

```
shadow.name.device-config.reported.telemetry_interval_ms:[4000 TO *]
```

---

## Discussion

- How would you use this pattern to gradually roll out a new firmware version across 3,000 devices?
- What monitoring would you put in place to catch a job that starts failing at 20%?
- How does the abort criteria protect against a bad script that bricks devices?

---

## Reference

- [IoT Jobs + Device Client analysis](../reference/decisions.md)
