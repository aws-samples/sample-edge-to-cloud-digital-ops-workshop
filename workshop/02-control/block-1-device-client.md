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
4. Walk through the `run-script.sh` handler — it reads `$2` (the S3 URI passed as a positional argument), downloads the script, and runs it

---

## Handler Script Contract

The Device Client calls a handler like this:

```
run-script.sh <runAsUser> <arg1> <arg2> ...
```

- `$1` — the `runAs` username from the job document (empty string if not set)
- `$2`, `$3`, … — entries from the `input.args` array in the job document

There is **no `JOB_DOCUMENT` environment variable**. All parameters the handler needs must be passed explicitly in the job document's `input.args` array.

```bash
#!/bin/bash
# $2 = S3 URI of the script to download and run
# Exit 0  → IoT Jobs marks this device as SUCCEEDED
# Exit 1+ → IoT Jobs marks this device as FAILED
```

---

## Reference

- [AWS IoT Device Client GitHub](https://github.com/awslabs/aws-iot-device-client)
- [Device Client 1.8 release — ECR images & expanded architecture support](https://aws.amazon.com/about-aws/whats-new/2022/12/aws-iot-device-client-1-8-release-ecr-enhanced-fuctionality/)
