# Block 1 — IoT Device Client Architecture

**Duration:** 45 min

---

## Overview

The AWS IoT Device Client is an open-source reference implementation written in C++ that runs directly on edge devices. It supports a broad range of hardware architectures — **x86_64, aarch64, armv7, PowerPC64, PowerPC64le, MIPS32** — and runs on Ubuntu, Amazon Linux, and Red Hat UBI8.

Because it is a compiled C++ binary, **you must build the artifact for the specific architecture and OS you intend to run it on.** The GitHub repository includes CMake toolchain files for cross-compilation (aarch64, armhf, MIPS, PowerPC) and Dockerfiles with the AWS IoT SDK pre-installed to use as build environments. The [GitHub Releases](https://github.com/awslabs/aws-iot-device-client/releases) page contains source code archives only — there are no pre-compiled binaries or publicly reachable Docker images.

## Choosing the Right AWS Edge Option

Not every device is the right fit for the Device Client. AWS offers five distinct options across the hardware spectrum — from bare-metal microcontrollers to full industrial gateways. Here's how they map to the devices you'd find in a typical oil & gas field:

| | **FreeRTOS + IoT Libraries** | **IoT ExpressLink** | **IoT Device Client** | **Greengrass v2** | **SiteWise Edge** |
|---|---|---|---|---|---|
| **Target hardware** | Bare-metal MCUs | Any host + co-processor module | Embedded Linux devices | Linux/Windows gateways & edge servers | Industrial gateways & edge servers |
| **Min RAM** | 4 – 256 KB | Host: none (module handles it) | ~64 MB (Linux userspace) | Full: ~128 MB · Lite: ~5 MB | 4 GB |
| **OS required** | None — FreeRTOS *is* the OS | None on host | Linux (Ubuntu, AL2, RHEL) | Linux or Windows | Linux or Windows |
| **Architectures** | ARM Cortex-M, RISC-V, Xtensa (ESP32), 40+ | Any (2-wire UART to module) | x86_64, ARM (aarch64, armv7, PowerPC, MIPS) | x86_64, ARMv8 | x86_64, ARMv8 |
| **MQTT / Shadows / Jobs** | ✅ | ✅ | ✅ | ✅ | ✅ (via Greengrass) |
| **OTA updates** | ✅ (firmware) | ✅ (module firmware) | ✅ (via IoT Jobs) | ✅ (component deployments) | ✅ |
| **Local compute / ML** | ❌ | ❌ | ❌ | ✅ (Lambda, containers, DLR) | ✅ (transforms, metrics) |
| **OPC-UA / Modbus** | ❌ | ❌ | ❌ | Via custom components | ✅ Native |
| **ESP32** | ✅ — primary choice | ✅ (as host) | ❌ | ❌ | ❌ |
| **Moxa UC gateway (Linux)** | ❌ | ❌ | ✅ | ✅ | ✅ |
| **Edge server / VM** | ❌ | ❌ | ✅ | ✅ | ✅ |
| **O&G sweet spot** | Sensor nodes, well-head monitors, tank gauges | Retrofitting legacy PLCs/RTUs via serial port | PoC connectivity, fleet provisioning, security posture | Edge analytics, ML inference, buffered telemetry | SCADA/DCS/historian integration, local operator dashboards |

**Three-tier mental model for a typical well site:**

1. **Sensor tier** — ESP32, STM32, or other MCU → **FreeRTOS** (or **ExpressLink** to add cloud connectivity to an existing device without reflashing)
2. **Gateway tier** — Moxa UC-8100, Advantech EPC, Raspberry Pi CM4 → **IoT Device Client** (simple telemetry & remote ops) or **Greengrass Nucleus Lite** (lightweight local processing)
3. **Edge compute tier** — ruggedised x86 server, Lenovo ThinkEdge → **Greengrass v2 Full** for custom ML workloads, or **SiteWise Edge** for OPC-UA/Modbus aggregation and local historian feeds

This workshop uses the **IoT Device Client** because it runs on the Linux EC2 instances standing in for gateway-class hardware, and because its simplicity makes the Jobs/handler contract easy to inspect and reason about.

---

Review how AWS IoT Device Client works as a `systemd` service alongside the EC2 application:

- The Device Client runs as a `systemd` service that maintains the MQTT connection
- It watches a **job handler directory** for job documents delivered by IoT Jobs
- Each handler script receives the job document as `stdin` and must exit with `0` (SUCCESS) or non-zero (FAILED)
- The Device Client reports back to IoT Jobs automatically based on the exit code

## Steps

1. Navigate to [**Systems Manager → Session Manager**](https://console.aws.amazon.com/systems-manager/session-manager/sessions) → start a session on one of the 3 EC2 instances (no SSH required)
2. Inspect the Device Client service:
   ```bash
   systemctl status aws-iot-device-client
   sudo journalctl -u aws-iot-device-client -n 50
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
