#!/usr/bin/env bash
# build-device-client.sh — single source of truth for the aws-iot-device-client
# binary's PROVENANCE (version pin + #166 keep-alive patch) and its TWO build
# paths. Factored out of scripts/sandbox.sh (issue #173) so the local Docker
# build and the CI-published artifact can never drift.
#
# Two consumers, one provenance:
#   • scripts/sandbox.sh SOURCES this file for the shared DEVICE_CLIENT_*
#     constants, fetch_prebuilt_device_client() (the Docker-free path) and
#     build_device_client_binary() (the Docker fallback).
#   • .github/workflows/build-device-client.yml RUNS this file directly
#     (`build-device-client.sh <output-path>`) on a Docker-capable GitHub runner
#     to produce the published GitHub Release asset that sandbox.sh fetches.
#
# Because both build paths clone the SAME pinned tag and apply the SAME patch via
# the SAME _dc_clone_and_patch() function, a fetched binary is behaviourally
# identical to one built locally with Docker — same version, same source patch.
#
# Behaviour:
#   • when SOURCED  → defines constants + functions, builds nothing.
#   • when EXECUTED → builds the binary (Docker) to $1.

set -euo pipefail

# ── Provenance: version pin + patch identity ────────────────────────────────
# Keep these two in lockstep with the patch applied in _dc_clone_and_patch().
DEVICE_CLIENT_VERSION="v1.10.1"
# Bump this whenever the patch set below changes, so a stale cached OR published
# artifact from before the change is never reused silently. It feeds BOTH the
# local cache filename (sandbox.sh) AND the published release tag/asset name.
DEVICE_CLIENT_PROVENANCE="keepalive-v1"

# GitHub Release coordinates the CI workflow publishes to and sandbox.sh fetches
# from. The tag encodes the provenance so a version/patch bump lands as a new,
# distinct release rather than silently overwriting the old artifact.
DEVICE_CLIENT_REPO="${DEVICE_CLIENT_REPO:-aws-samples/sample-edge-to-cloud-digital-ops-workshop}"
DEVICE_CLIENT_RELEASE_TAG="device-client-${DEVICE_CLIENT_VERSION}-${DEVICE_CLIENT_PROVENANCE}"
DEVICE_CLIENT_ASSET="aws-iot-device-client"

# ── Clone the pinned source and apply the #166 keep-alive patch ─────────────
# Shared by BOTH build paths. Leaves a patched, ready-to-build source tree at $1.
_dc_clone_and_patch() {
  local dc_src="$1"
  git clone --depth 1 --branch "$DEVICE_CLIENT_VERSION" \
    https://github.com/awslabs/aws-iot-device-client "$dc_src"
  # #166: v1.10.1 never opts its MQTT socket into SO_KEEPALIVE (no call to
  # WithTcpKeepAlive() anywhere in SharedCrtResourceManager.cpp, confirmed by
  # reading the pinned tag's source), and Connect() is called with
  # keepAliveTimeSecs=0, which falls back to the aws-c-mqtt SDK's hardcoded
  # 1200s default (source/client.c: s_default_keep_alive_sec). Kernel TCP
  # keepalive (the sysctl tuning in participant-stack.ts) only fires on
  # sockets that have opted in via SO_KEEPALIVE, so it is inert against this
  # socket without this patch. There is also no config-schema field to
  # express this without a source change (PlainConfig has no keep-alive key).
  # Patch: opt the MQTT socket into TCP keepalive so the OS-level sysctl
  # values actually apply to it, and lower the MQTT PINGREQ interval itself
  # below the 350s NAT idle timeout so protocol-level traffic keeps the flow
  # warm even if TCP keepalive is ever disabled at the OS layer.
  local keepalive_patch_marker='clientConfigBuilder.WithSdkVersion(DEVICE_CLIENT_VERSION);'
  local connect_patch_marker='connection->Connect(config.thingName->c_str(), false)'
  grep -qF "$keepalive_patch_marker" "$dc_src/source/SharedCrtResourceManager.cpp" || {
    echo "ERROR: #166 keep-alive patch anchor not found in SharedCrtResourceManager.cpp — upstream source has changed, update the patch." >&2
    return 1
  }
  grep -qF "$connect_patch_marker" "$dc_src/source/SharedCrtResourceManager.cpp" || {
    echo "ERROR: #166 keep-alive patch Connect() anchor not found in SharedCrtResourceManager.cpp — upstream source has changed, update the patch." >&2
    return 1
  }
  # Use perl (not `sed -i`) for portability: BSD/macOS sed requires an explicit
  # backup-suffix arg after -i and does not expand `\n` in the replacement, so a
  # GNU-style `sed -i "s|...|...\n...|"` fails on a Mac host with
  # "invalid command code". perl -i -pe behaves identically on macOS and Linux.
  # \Q..\E matches the anchors as literal strings (the ()/./-> chars are not
  # treated as regex); the markers are passed via env to avoid quoting issues.
  KP="$keepalive_patch_marker" perl -i -pe \
    's/\Q$ENV{KP}\E/$ENV{KP}\n    clientConfigBuilder.WithTcpKeepAlive();/' \
    "$dc_src/source/SharedCrtResourceManager.cpp"
  CP="$connect_patch_marker" perl -i -pe \
    's/\Q$ENV{CP}\E/connection->Connect(config.thingName->c_str(), false, 180, 10000)/' \
    "$dc_src/source/SharedCrtResourceManager.cpp"
  # Drop the unit-test subdirectory from the build. v1.10.1's top-level
  # CMakeLists.txt calls `add_subdirectory(test)` unconditionally, and
  # test/CMakeLists.txt then requires gtest — either via a configure-time
  # `git clone` of googletest (BUILD_TEST_DEPS=ON, which fails intermittently
  # with "Could not resolve host", especially under amd64 emulation) or via
  # `find_package(GTest REQUIRED)` (BUILD_TEST_DEPS=OFF, which errors when gtest
  # isn't installed). We only ship the production binary, so remove the test
  # dir entirely — no gtest needed by any path, and one less flaky network step.
  local test_subdir_marker='add_subdirectory(test)'
  grep -qF "$test_subdir_marker" "$dc_src/CMakeLists.txt" || {
    echo "ERROR: 'add_subdirectory(test)' not found in CMakeLists.txt — upstream layout changed, update the patch." >&2
    return 1
  }
  TS="$test_subdir_marker" perl -i -pe \
    's/^(\s*)(\Q$ENV{TS}\E)/$1# $2  # removed: production build needs no gtest/' \
    "$dc_src/CMakeLists.txt"
}

# ── Docker build path (fallback; requires Docker) ───────────────────────────
# Clones + patches the pinned source, cross-compiles inside amazonlinux:2023,
# and writes the resulting binary to $1.
build_device_client_binary() {
  local dest="$1"
  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker is not available — cannot run the local device-client build." >&2
    return 1
  fi
  local dc_src
  dc_src=$(mktemp -d)
  _dc_clone_and_patch "$dc_src"
  # Use public.ecr.aws/amazonlinux/amazonlinux and run cmake install + build
  # steps directly inside the container.
  # AL2023 (OpenSSL 3.x) is required — IoT Device Client v1.10.1 needs OpenSSL >= 1.1,
  # but AL2 ships 1.0.2k. Explicit OPENSSL_*_LIBRARY paths work around cmake's
  # FindOpenSSL module failing to locate libcrypto/libssl on this image.
  # Pin --platform linux/amd64: the edge EC2 instances are x86_64, but on an
  # Apple Silicon host Docker would otherwise build a linux/arm64 binary that
  # dies on the device with "Exec format error" (status=203/EXEC). Emulated
  # amd64 build is slower but produces the correct arch. (CI's ubuntu-latest is
  # already amd64, so this is a no-op there.)
  docker run --rm --platform linux/amd64 \
    -v "$dc_src:/root/aws-iot-device-client" \
    public.ecr.aws/amazonlinux/amazonlinux:2023 \
    bash -c "
      dnf install -y cmake gcc gcc-c++ openssl-devel \
        libcurl-devel git make zip unzip tar && \
      cd /root/aws-iot-device-client && \
      cmake -B build -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_TEST_DEPS=OFF \
        -DEXCLUDE_JOBS=OFF -DEXCLUDE_NAMED_SHADOW=OFF \
        -DEXCLUDE_TUNNELING=ON -DEXCLUDE_DEVICE_DEFENDER=ON \
        -DEXCLUDE_FLEET_PROVISIONING=OFF \
        -DOPENSSL_CRYPTO_LIBRARY=/usr/lib64/libcrypto.so \
        -DOPENSSL_SSL_LIBRARY=/usr/lib64/libssl.so && \
      cmake --build build --target aws-iot-device-client -j\$(nproc) && \
      chmod -R a+rwX /root/aws-iot-device-client 2>/dev/null || true
    "
  mkdir -p "$(dirname "$dest")"
  cp "$dc_src/build/aws-iot-device-client" "$dest"
  rm -rf "$dc_src"
}

# ── Fetch path (no Docker, no AWS creds) ────────────────────────────────────
# Downloads the pre-built binary published by build-device-client.yml to the
# GitHub Release tagged $DEVICE_CLIENT_RELEASE_TAG, writing it to $1. Returns
# non-zero (without writing $1) if no such artifact is available yet, so callers
# can fall back to the Docker build. Works on the public repo with no auth
# (plain HTTPS); uses `gh` if present (also covers a private fork).
fetch_prebuilt_device_client() {
  local dest="$1"
  local url="https://github.com/${DEVICE_CLIENT_REPO}/releases/download/${DEVICE_CLIENT_RELEASE_TAG}/${DEVICE_CLIENT_ASSET}"
  local tmp
  tmp=$(mktemp)
  if command -v gh >/dev/null 2>&1 && \
     gh release download "$DEVICE_CLIENT_RELEASE_TAG" --repo "$DEVICE_CLIENT_REPO" \
       --pattern "$DEVICE_CLIENT_ASSET" --output "$tmp" --clobber >/dev/null 2>&1; then
    :
  elif command -v curl >/dev/null 2>&1 && curl -fsSL "$url" -o "$tmp" 2>/dev/null; then
    :
  else
    rm -f "$tmp"
    return 1
  fi
  # Guard against a 404/HTML body being saved as a "binary": require a non-empty
  # file whose first 4 bytes are the ELF magic (7f 45 4c 46).
  local magic=""
  if [[ -s "$tmp" ]]; then
    magic=$(head -c 4 "$tmp" | od -An -tx1 | tr -d ' \n')
  fi
  if [[ "$magic" != "7f454c46" ]]; then
    rm -f "$tmp"
    return 1
  fi
  chmod +x "$tmp"
  mkdir -p "$(dirname "$dest")"
  mv "$tmp" "$dest"
}

# ── Direct execution: build to $1 (used by build-device-client.yml) ─────────
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  OUT="${1:-}"
  if [[ -z "$OUT" ]]; then
    echo "Usage: $0 <output-path>   # builds aws-iot-device-client ${DEVICE_CLIENT_VERSION} (${DEVICE_CLIENT_PROVENANCE}) to <output-path>" >&2
    exit 1
  fi
  echo ">>> Building aws-iot-device-client ${DEVICE_CLIENT_VERSION} (${DEVICE_CLIENT_PROVENANCE}) → ${OUT}"
  build_device_client_binary "$OUT"
  echo ">>> Built: ${OUT}"
fi
