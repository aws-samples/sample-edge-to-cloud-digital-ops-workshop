# Block 1 — Named Shadow Architecture

**Duration:** 45 min

---

## The Three-Shadow Design

| Shadow | Owned By | Purpose |
|---|---|---|
| `device-config` | Cloud (desired) + Device (reported) | Config version, telemetry interval, feature flags |
| `app-deployment` | Cloud (desired) + Device (reported) | Compose version, container image tags, deploy status |
| `device-health` | Device (reported only) | CPU/mem/disk %, container count, uptime, last heartbeat |

---

## Why Separate Shadows?

- **`device-config`** is a control plane object — the cloud writes desired state, the device converges to it. Used for live tuning (e.g., change telemetry interval without a job).
- **`app-deployment`** is a deployment state tracker — the cloud sets the target version, the device reports what it actually deployed. Enables drift detection at the software layer.
- **`device-health`** is device-reported only — the cloud never writes to it. It's a health heartbeat: if `last_heartbeat` goes stale, the device is unhealthy.

!!! tip "Shadow size limit"
    Each named shadow is limited to **8 KB**. Keep high-frequency telemetry in MQTT topics, not shadows. Shadows are for slow-changing state and health signals.

---

## The Desired/Reported/Delta Pattern

```json
{
  "state": {
    "desired": {
      "telemetry_interval_ms": 1000
    },
    "reported": {
      "telemetry_interval_ms": 5000
    },
    "delta": {
      "telemetry_interval_ms": 1000
    }
  }
}
```

The Device Client subscribes to the `delta` topic. When desired ≠ reported, IoT Core publishes the delta. The device acts on it and updates `reported` — delta disappears when they converge.

---

## Reference

- [Named Device Shadows](https://docs.aws.amazon.com/iot/latest/developerguide/iot-device-shadows.html)
