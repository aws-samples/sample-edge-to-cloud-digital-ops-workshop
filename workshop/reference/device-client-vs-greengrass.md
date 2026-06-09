# AWS IoT Device Client vs. Greengrass v2 Core

This reference compares the two main options for running AWS IoT connectivity software on a Linux device or container. The workshop uses the **AWS IoT Device Client**. This page explains why, and when Greengrass v2 would be the better choice.

---

## Quick Comparison

| | AWS IoT Device Client | AWS IoT Greengrass v2 |
|---|---|---|
| **Primary use case** | Lightweight IoT connectivity agent | Full edge runtime + component platform |
| **Runtime** | Single static binary (~36 MB) | JVM (Java 11+), ~200 MB image |
| **Pre-built container** | GHCR build image — binary built once, distributed via S3 | No pre-built multi-arch image; must build from Dockerfile |
| **Fleet provisioning by claim** | ✅ Built-in | ✅ Built-in (FleetProvisioningByClaim plugin) |
| **IoT Jobs / remote scripts** | ✅ Built-in handler, executes scripts directly | ⚠️ Requires a custom component |
| **Named device shadows** | ✅ Built-in | ✅ Via Shadow Manager component |
| **MQTT telemetry** | ✅ Direct publish | ✅ Via local Moquette broker + IoT Core bridge |
| **Config complexity** | One JSON file + certs | `.env` + `config.yaml` + IAM token exchange role |
| **IAM requirements** | IoT policy only | IoT policy + IAM role + role alias (token exchange) |
| **Component model** | None — single process | Full lifecycle manager + per-feature components |
| **Workshop setup time** | ~5 min | ~30–45 min |

---

## Fleet Provisioning by Claim

Both tools support the same underlying mechanism: a **claim certificate** connects to IoT Core, calls `RegisterThing` via a provisioning template, receives a permanent device certificate, and registers the Thing.

- **Device Client**: configured directly in `aws-iot-device-client.conf` under `fleet-provisioning`.
- **Greengrass v2**: uses the `aws.greengrass.FleetProvisioningByClaim` plugin in `config.yaml`.

The workshop uses the Device Client because the config is a single flat JSON file — participants can see exactly what parameters drive the provisioning flow.

---

## IoT Jobs / Remote Script Execution

This is the key difference for the workshop.

**Device Client**: has a built-in job handler. The job document uses the `version: "1.0"` / `steps` format — the handler name and its arguments (e.g. an S3 script URI) are passed as positional args; the handler downloads the script and executes it. No extra software needed.

**Greengrass v2**: does **not** execute arbitrary IoT Jobs natively. To achieve the same result you must:
1. Write a custom Greengrass component that subscribes to the IoT Jobs queue
2. Deploy that component to the device via a Greengrass deployment

The component model is powerful for production — it gives you versioning, rollback, and dependency management. For a workshop teaching the IoT Jobs primitive, it adds abstraction that obscures the underlying mechanism.

---

## Container Images

**AWS IoT Device Client (GHCR)**

```
ghcr.io/awslabs/aws-iot-device-client/amazonlinux:latest
```

This is a **build environment** image, not a runtime image. The workflow:

```bash
# Build the binary once using the container (source mounted at /root/aws-iot-device-client)
git clone --depth 1 --branch v1.10.1 https://github.com/awslabs/aws-iot-device-client ./dc
docker run --rm -v ./dc:/root/aws-iot-device-client \
  ghcr.io/awslabs/aws-iot-device-client/amazonlinux:latest
# Binary output: ./dc/build/aws-iot-device-client
```

The resulting static binary runs natively on the host — no Docker required at runtime. The workshop `sandbox.sh` builds it once and caches it in S3; EC2 instances download it at launch.

**AWS IoT Greengrass v2 (Docker Hub)**

```
amazon/aws-iot-greengrass:latest   # DEPRECATED — removed December 2023
```

!!! warning
    The `amazon/aws-iot-greengrass` Docker Hub image is deprecated and no longer supported. AWS removed it at end of 2023.

For Greengrass v2 in Docker, you must build your own image from the [reference Dockerfile](https://github.com/aws-greengrass/aws-greengrass-docker). Since the Greengrass nucleus is a platform-independent Java JAR, you can build for both x86_64 and ARM64 using `docker buildx`. There is no pre-built multi-arch image you can `docker pull`.

---

## When to Use Each

**Use the Device Client when:**
- You need lightweight, scriptable IoT connectivity (provisioning + jobs + shadows + MQTT)
- You want participants to see the raw IoT primitives without extra abstraction
- You're running a workshop or prototype where setup time matters
- You don't need a full edge application platform

**Use Greengrass v2 when:**
- You need to deploy and manage long-lived edge applications (ML inference, stream processing, custom protocols)
- You want component versioning, dependency management, and rollback
- You're building a production system that will evolve over time
- You need Greengrass-specific integrations (Local Shadow Service, Stream Manager, Modbus/OPC-UA protocol adapters)

---

## Production Upgrade Path

The workshop architecture is designed to be a simplified version of a production pattern. When moving to production:

| Workshop | Production equivalent |
|---|---|
| Device Client + claim cert provisioning | Device Client or Greengrass v2 + claim cert provisioning |
| IoT Jobs + `run-script.sh` | IoT Jobs (Device Client) or Greengrass deployments |
| Named shadows | Named shadows (same on both) |
| K3s edge cluster | RKE2 (FIPS 140-2 validated) |
| Redpanda Community | Redpanda Enterprise (Tiered Storage, RBAC, FIPS) |

---

## References

- [AWS IoT Device Client — GitHub](https://github.com/awslabs/aws-iot-device-client)
- [Device Client: Fleet Provisioning](https://github.com/awslabs/aws-iot-device-client/blob/main/source/fleetprovisioning/README.md)
- [Greengrass v2: Fleet Provisioning by Claim](https://docs.aws.amazon.com/greengrass/v2/developerguide/fleet-provisioning.html)
- [Greengrass v2: Run in Docker](https://docs.aws.amazon.com/greengrass/v2/developerguide/run-greengrass-docker.html)
- [Greengrass v2: Build from Dockerfile](https://docs.aws.amazon.com/greengrass/v2/developerguide/build-greengrass-dockerfile.html)
- [Remote script execution on Greengrass (AWS re:Post)](https://repost.aws/questions/QUB7Mge2fpTzqC6XvwAU1F6A/remote-bash-script-execution-on-greengrass-edge-device)
