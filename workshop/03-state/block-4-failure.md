# Block 4 — Failure Detection

**Duration:** 45 min

---

## Simulate a Failure

1. **Stop one EC2 instance** via the EC2 console
2. Watch the UI: the device heartbeat goes stale — `device-health` shadow `last_heartbeat` stops updating
3. After ~90 seconds, the UI marks the device as **`OFFLINE`** (heartbeat age > 60 s threshold)
4. Check **IoT Core → Manage → Things → (device) → Activity** — connectivity status shows `DISCONNECTED`

---

## Two Independent Signal Layers

| Signal | Source | What it detects |
|---|---|---|
| **Shadow staleness** | Application layer — `device-health.reported.last_heartbeat` | Device process stopped, handler crashed, heartbeat timer failed |
| **IoT Core connectivity** | Transport layer — MQTT keep-alive timeout | Network unreachable, instance stopped, OS crash |

Using both gives you defence in depth: a device can be connected to IoT Core but have a crashed application (shadow staleness catches it), or disconnected entirely (connectivity status catches it).

---

## Recovery

1. **Restart the instance** via EC2 console
2. Observe the device reconnect using its existing permanent certificate — **no re-provisioning occurs** (the claim cert was deleted after first boot; the Device Client simply re-establishes the MQTT connection)
3. Shadows re-populate automatically as the timer units resume
4. The UI transitions back to `ONLINE`

---

## Wrap-Up

Recap the shadow model: desired/reported/delta pattern; named shadows for separation of concerns.

**Preview Session 4:** Cloud analytics — RisingWave materialized views, TimescaleDB continuous aggregates, and a side-by-side data freshness comparison across three storage tiers.
