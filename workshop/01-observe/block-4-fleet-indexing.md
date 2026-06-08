# Block 4 — Fleet Indexing Introduction

**Duration:** 45 min

---

## Steps

1. Navigate to **IoT Core → Manage → Fleet Hub** → (Note: Fleet Hub is EOL as of Oct 2025 — use the **IoT Device Management** console directly)
2. Enable Fleet Indexing for Thing attributes, shadows, and connectivity status
3. Run a basic fleet query to confirm all 3 devices are visible:
   ```
   thingName:*
   ```
4. Query by shadow state — confirm initial config version:
   ```
   shadow.name.device-config.reported.config_version:1.0.0
   ```
5. Query connectivity status:
   ```
   connectivity.connected:true
   ```

---

## Discussion Questions

- What is the difference between a static Thing Group and a Dynamic Thing Group?
- How would you target a job at "all devices still on firmware 1.0.0"?
- What's the eventual-consistency caveat with Dynamic Thing Groups? (Group membership evaluates asynchronously — newly registered devices may take seconds to appear.)

---

## Wrap-Up

Recap the full Session 1 data path:

```
EC2 (IoT Device Client)
  → MQTT publish → IoT Core
  → IoT Rules Engine → Kafka action → MSK
  → MSK Connect (Hudi Sink) → S3
  → Athena (Glue catalog)
```

**Preview Session 2:** Next week you'll use IoT Jobs to push a script update to all 3 devices simultaneously — changing telemetry frequency from 0.2 Hz to 1 Hz and adding network I/O metrics.

---

## Reference

- [IoT Fleet Indexing](https://docs.aws.amazon.com/iot/latest/developerguide/iot-indexing.html)
- [Dynamic Thing Groups](https://docs.aws.amazon.com/iot/latest/developerguide/dynamic-thing-groups.html)
