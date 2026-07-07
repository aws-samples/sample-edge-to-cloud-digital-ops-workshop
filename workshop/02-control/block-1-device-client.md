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

## Register Your Own Device

The 3 EC2 instances self-registered on boot. You can also register a device **you** bring —
a Raspberry Pi, a spare Linux box, a VM — into your slot over SSH. This runs the same
fleet-provisioning-by-claim flow from [Block 0](../01-observe/block-0-fleet-provisioning.md),
driven from your laptop by [`scripts/register-device-ssh.sh`](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/scripts/register-device-ssh.sh).

**How it works:** the script runs on *your* machine with *your* AWS credentials. It fetches
the shared claim certificate from Secrets Manager, connects to the device over SSH, builds the
Device Client on the device, installs the claim cert + config, and starts the `systemd`
service. The device self-registers and IoT Core mints it a unique per-device certificate.
**The device never holds AWS credentials** — its only secret is the claim cert, scoped to the
provisioning topics.

```bash
./scripts/register-device-ssh.sh \
  --ssh pi@raspberrypi.local \
  --deployment-id ws-slot00 \
  --thing-name my-pi-01
```

### Building the Device Client for your device

The script builds the Device Client **on the device itself**, so the binary matches the
device's architecture, libc, and OpenSSL version automatically — no cross-compilation. The
default install line targets **Raspberry Pi OS / Debian / Ubuntu (arm64)**:

??? example "View source — build the Device Client on the device"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/scripts/register-device-ssh.sh){ .md-button target=_blank }

    ```bash
    --8<-- "scripts/register-device-ssh.sh:build-device-client"
    ```

To register a device on a **different OS stack**, change only the package-install line in that
block:

| OS stack | Install command |
|---|---|
| Raspberry Pi OS / Debian / Ubuntu (arm64) — *default* | `sudo apt-get install -y cmake gcc g++ libssl-dev libcurl4-openssl-dev git make` |
| Amazon Linux 2023 / RHEL / Fedora | `sudo dnf install -y cmake gcc gcc-c++ openssl-devel libcurl-devel git make` |
| Alpine | `sudo apk add cmake g++ openssl-dev curl-dev git make` |

The rule: **build on the same OS/arch family the binary will run on.** IoT Device Client
v1.10.1 needs OpenSSL ≥ 1.1 (Raspberry Pi OS Bookworm ships 3.x).

### The claim cert and config

After the build, the script splits the claim cert out of Secrets Manager, copies it to the
device, and writes the Device Client config with a `fleet-provisioning` block:

??? example "View source — push claim cert and write config"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/scripts/register-device-ssh.sh){ .md-button target=_blank }

    ```bash
    --8<-- "scripts/register-device-ssh.sh:provision"
    ```

The script then polls the IoT registry until your new Thing appears.

!!! warning "The claim cert is a shared secret"
    Because the pre-provisioning hook is log-only in this workshop, anyone holding the claim
    cert can register a device into your slot. Only deliver it to a device over SSH from your
    own machine — never commit it or paste it into a shared channel.

---

## Reference

- [AWS IoT Device Client GitHub](https://github.com/awslabs/aws-iot-device-client)
- [Device Client 1.8 release — ECR images & expanded architecture support](https://aws.amazon.com/about-aws/whats-new/2022/12/aws-iot-device-client-1-8-release-ecr-enhanced-fuctionality/)
