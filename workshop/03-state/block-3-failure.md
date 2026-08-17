# Block 3 — Failure Detection

**Duration:** 45 min

---

## Simulate a Failure

1. **Confirm all devices are online first.** Via Fleet Indexing, [search for connected devices in your slot](https://console.aws.amazon.com/iot/home#/search?indexType=AWS_Things&search=attributes.deploymentId%3Aws-slot00%20AND%20connectivity.connected%3Atrue): the `connectivity.connected:true` query returns all of your devices
2. **Stop one EC2 instance** via the [EC2 console → Instances](https://console.aws.amazon.com/ec2/home#Instances:instanceState=running;tag:Name=:ws-slot00-edge;v=3;$case=tags:true%5C,client:false;$regex=tags:false%5C,client:false) (select a `workshop-ws-slot00-edge-*` instance → **Instance state → Stop instance**)
3. Wait ~90 seconds — the device heartbeat goes stale (`device-health` shadow `reported.last_heartbeat` stops updating) and the UI marks the device as **`OFFLINE`** (heartbeat age > 60 s threshold)
4. **Re-run the Fleet Indexing query to confirm the new state** — [search for disconnected devices in your slot](https://console.aws.amazon.com/iot/home#/search?indexType=AWS_Things&search=attributes.deploymentId%3Aws-slot00%20AND%20connectivity.connected%3Afalse): the `connectivity.connected:false` query now returns the stopped device

---

## Two Independent Signal Layers

| Signal | Source | What it detects |
|---|---|---|
| **Shadow staleness** | Application layer — `device-health.reported.last_heartbeat` | Device process stopped, handler crashed, heartbeat timer failed |
| **IoT Core connectivity** | Transport layer — MQTT keep-alive timeout | Network unreachable, instance stopped, OS crash |

Using both gives you defence in depth: a device can be connected to IoT Core but have a crashed application (shadow staleness catches it), or disconnected entirely (connectivity status catches it).

---

## Recovery

1. **Restart the instance** via the [EC2 console → Instances](https://console.aws.amazon.com/ec2/home#Instances:instanceState=stopped;tag:Name=:ws-slot00-edge;v=3;$case=tags:true%5C,client:false;$regex=tags:false%5C,client:false) (select the stopped `workshop-ws-slot00-edge-*` instance → **Instance state → Start instance**)
2. Observe the device reconnect using its existing permanent certificate — **no re-provisioning occurs** (the claim cert was deleted after first boot; the Device Client simply re-establishes the MQTT connection)
3. Shadows re-populate automatically as the timer units resume
4. The UI transitions back to `ONLINE`

---

## Wrap-Up

Recap the shadow model: desired/reported/delta pattern; named shadows for separation of concerns.

**Preview Session 4:** Cloud analytics — RisingWave materialized views, TimescaleDB continuous aggregates, and a side-by-side data freshness comparison across three storage tiers.
