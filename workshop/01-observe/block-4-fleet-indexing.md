# Block 4 — Fleet Indexing Introduction

**Duration:** 45 min

---

## Steps

1. Navigate to [**IoT Core → Settings → Fleet indexing → Manage indexing**](https://console.aws.amazon.com/iot/home#/settings)
2. Enable Thing indexing and select the following data sources:
   - **Add thing connectivity** — indexes connected/disconnected state, disconnect reason, and last connection timestamp
   - **Include socket information** *(new)* — indexes source IP, source port, target IP, target port, and VPC endpoint ID per connection
   - **Add named shadows** — add `device-config`
   - **Add device software packages and versions** — indexes the reserved `$package` shadow for version-targeted queries
3. Click **Update** and wait for index status to show `ACTIVE`:
   ```bash
   aws iot describe-index --index-name AWS_Things
   ```
4. Navigate to **IoT Core → Manage → Things** and use the search bar to confirm all 3 devices are visible:
   ```
   thingName:*
   ```
5. Query by shadow state — confirm initial config version:
   ```
   shadow.name.device-config.reported.config_version:1.0.0
   ```
6. Query connectivity status:
   ```
   connectivity.connected:true
   ```
7. Query by software package version — confirm all devices are on `telemetry-agent` v1.0.0:
   ```
   shadow.name.$package.reported.telemetry-agent.version:1.0.0
   ```
8. Query by source IP (socket indexing) — inspect where devices are connecting from:
   ```
   connectivity.sourceIp:*
   ```

---

## Discussion Questions

- What is the difference between a static Thing Group and a Dynamic Thing Group?
- How would you target a job at "all devices still on `telemetry-agent` v1.0.0"? (Hint: use the `$package` shadow query from step 7 as the Dynamic Thing Group filter.)
- What's the eventual-consistency caveat with Dynamic Thing Groups? (Group membership evaluates asynchronously — newly registered devices may take seconds to appear.)
- What does socket indexing let you do that plain connectivity indexing doesn't? (Answer: pinpoint which source IPs/ports are connecting — useful for diagnosing NAT traversal issues or spotting devices connecting from unexpected networks.)

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
- [Managing fleet indexing](https://docs.aws.amazon.com/iot/latest/developerguide/managing-fleet-index.html)
- [Dynamic Thing Groups](https://docs.aws.amazon.com/iot/latest/developerguide/dynamic-thing-groups.html)
- [Fleet indexing with Software Package Catalog](https://docs.aws.amazon.com/iot/latest/developerguide/preparing-fleet-indexing.html)
- [Example thing queries](https://docs.aws.amazon.com/iot/latest/developerguide/example-queries.html)
