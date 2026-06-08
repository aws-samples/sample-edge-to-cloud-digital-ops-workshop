# Block 2 — Deploy Shadow Update Job

**Duration:** 60 min

---

## What the Job Does

1. Adds **`app-deployment`** shadow reporting — reads current Docker Compose version from file, publishes to shadow
2. Adds **`device-health`** shadow reporting — a periodic heartbeat every 30 seconds with system metrics

---

## Steps

1. Create an IoT Job targeting Thing Group `ws-{DEPLOYMENT_ID}`
2. The job script adds two new `systemd` timer units:
   - `shadow-app-deployment.timer` — reports compose version and image tags
   - `shadow-device-health.timer` — reports CPU/mem/disk %, container count, uptime, `last_heartbeat`
3. Observe the new shadows appearing in **IoT Core → Manage → Things → (device) → Shadows**
4. Use Fleet Indexing to query device health across the fleet:

```
shadow.name.device-health.reported.cpu_pct:[50 TO *]
```

---

## Discussion

- What happens if a device loses connectivity for 5 minutes and then reconnects? Does the shadow reflect the last reported state or the current state?
- How would you use the `app-deployment` shadow to detect that a device hasn't received the latest update?

---

## Reference

- [Named Device Shadows](https://docs.aws.amazon.com/iot/latest/developerguide/iot-device-shadows.html)
