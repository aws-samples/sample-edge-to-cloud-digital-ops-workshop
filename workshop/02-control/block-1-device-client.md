# Block 1 — IoT Device Client Architecture

**Duration:** 45 min

---

## Overview

The AWS IoT Device Client is an open-source reference implementation that runs directly on edge devices. It supports a broad range of hardware architectures — **x86_64, aarch64, armv7, PowerPC64, PowerPC64le, MIPS32** — and runs on Ubuntu, Amazon Linux, and Red Hat UBI8. Docker images for the most common architectures (x86_64, aarch64, armv7) are available through ECR, making it straightforward to deploy via containers on capable devices.

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
   cat /etc/aws-iot-device-client/jobs/run-script.sh
   ```
4. Walk through the `run-script.sh` handler — it reads `scriptUri` from the job document, downloads the script from S3, and runs it

---

## Handler Script Contract

```bash
#!/bin/bash
# The Device Client injects JOB_DOCUMENT as an env var containing the raw JSON.
# run-script.sh parses the scriptUri field, downloads the script from S3, and executes it.
# Exit 0  → IoT Jobs marks this device as SUCCEEDED
# Exit 1+ → IoT Jobs marks this device as FAILED
```

---

## Reference

- [AWS IoT Device Client GitHub](https://github.com/awslabs/aws-iot-device-client)
- [Device Client 1.8 release — ECR images & expanded architecture support](https://aws.amazon.com/about-aws/whats-new/2022/12/aws-iot-device-client-1-8-release-ecr-enhanced-fuctionality/)
