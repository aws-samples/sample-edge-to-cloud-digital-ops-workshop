# Block 1 — Orientation & Console Tour

**Duration:** 45 min

---

## Steps

1. Facilitator walks through the deployed architecture diagram
2. Navigate to [**IoT Core → Test → MQTT test client**](https://console.aws.amazon.com/iot/home#/test)
3. Subscribe to `edge/{YOUR_DEPLOYMENT_ID}/#`
4. Observe incoming telemetry messages at 0.2 Hz; inspect the JSON payload structure
5. Navigate to [**IoT Core → Manage → Things**](https://console.aws.amazon.com/iot/home#/thinghub) → confirm 3 registered devices

---

## Discussion Questions

- Why MQTT? What is a topic namespace?
- Now that you understand provisioning, connect the dots: the Thing name in the topic path matches the Thing created by the provisioning template.
- What does the 0.2 Hz frequency tell you about the initial telemetry configuration?

---

## Reference

- [IoT Core MQTT test client](https://docs.aws.amazon.com/iot/latest/developerguide/view-mqtt-messages.html)
