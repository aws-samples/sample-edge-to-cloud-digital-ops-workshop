# Block 1 — IoT Device Client Architecture

**Duration:** 45 min

---

## Overview

Review how AWS IoT Device Client works as a `systemd` service alongside the EC2 application:

- The Device Client runs as a `systemd` service that maintains the MQTT connection
- It watches a **job handler directory** for job documents delivered by IoT Jobs
- Each handler script receives the job document as `stdin` and must exit with `0` (SUCCESS) or non-zero (FAILED)
- The Device Client reports back to IoT Jobs automatically based on the exit code

## Steps

1. Navigate to **Systems Manager → Session Manager** → start a session on one of the 3 EC2 instances (no SSH required)
2. Inspect the Device Client service:
   ```bash
   systemctl status aws-iot-device-client
   journalctl -u aws-iot-device-client -n 50
   ```
3. Inspect the job handler directory:
   ```bash
   ls /etc/aws-iot-device-client/jobs/
   cat /etc/aws-iot-device-client/jobs/update-telemetry-config.sh
   ```
4. Walk through the structure of the existing `telemetry-config.sh` handler

---

## Handler Script Contract

```bash
#!/bin/bash
# Job document is available as environment variables injected by the Device Client
# Exit 0  → IoT Jobs marks this device as SUCCEEDED
# Exit 1+ → IoT Jobs marks this device as FAILED
```

---

## Reference

- [AWS IoT Device Client GitHub](https://github.com/awslabs/aws-iot-device-client)
