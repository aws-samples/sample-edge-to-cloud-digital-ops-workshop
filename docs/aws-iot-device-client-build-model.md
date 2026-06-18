# AWS IoT Device Client — Build Model and ECR Images

## What we got wrong

The [1.8 release announcement](https://aws.amazon.com/about-aws/whats-new/2022/12/aws-iot-device-client-1-8-release-ecr-enhanced-fuctionality/) says:

> AWS IoT Device Client docker images contain the latest release of Device Client software for x86_64, aarch64, and armv7 architectures running Ubuntu, Amazon Linux, or Red Hat Ubi8 through the Elastic Container Registry (ECR).

We initially read this as "pull and run" Docker images. That is incorrect.

## What the ECR images actually are

The images published to `public.ecr.aws/aws-iot-device-client/aws-iot-device-client-base-images` are **build base images**. They contain:

- The operating system (Ubuntu, Amazon Linux, or Red Hat UBI8)
- The AWS IoT C++ SDK and its dependencies, pre-compiled

They are designed to be used as the build environment for compiling the Device Client binary for a target architecture. The runbook confirms this — you run `./build.sh --compile-mode=armhf_cross_mode` (or similar) *inside* the container to produce the artifact.

The naming convention — `aws-iot-device-client-base-images` — reflects this: they are base images for building, not images you deploy to devices.

## How you actually get the Device Client onto a device

### What the CI publishes vs. what is reachable

The release CI (`release-ci.yml`) builds and pushes Docker images to two ECR public repos:
- `public.ecr.aws/aws-iot-device-client/aws-iot-device-client` — runnable images (binary inside)
- `public.ecr.aws/aws-iot-device-client/aws-iot-device-client-base-images` — build environments

However, these pushes use `secrets.DC_AWS_ACCOUNT_ID` (the Device Client team's internal AWS account). When tested on June 2026, both repos return `NAME_UNKNOWN` to external callers — the images are not publicly reachable even though ECR public is used. The GitHub Releases page also contains only source archives (`.zip` / `.tar.gz`), not compiled binaries.

**In practice, build from source is the only reliable path.**

### Build options

1. **Build from source using the Dockerfiles in the repo** — clone the repo, use `docker-build.sh` or the Dockerfiles under `.github/docker-images/` with the appropriate base OS. CMake toolchain files for cross-compilation are in `cmake-toolchain/`: `Toolchain-aarch64.cmake`, `Toolchain-armhf.cmake`, `Toolchain-mips.cmake`, `Toolchain-ppc64.cmake`, `Toolchain-ppc64le.cmake`.

2. **Yocto / meta-aws recipe** — for constrained or purpose-built embedded Linux distributions. See [github.com/aws4embeddedlinux/meta-aws](https://github.com/aws4embeddedlinux/meta-aws/tree/master/recipes-iot/aws-iot-device-client).

## Bottom line for the workshop

The workshop runs on EC2 (x86_64). The Device Client is installed as a binary via the Amplify/CloudFormation stack. No Docker involvement. If you were deploying this to actual edge hardware of a different architecture, you would need to build or download the correct binary for that arch/OS combination — a pre-built "run anywhere" container image does not exist.
