#!/usr/bin/env bash
# Usage: ./scripts/build-cloud-dashboard.sh [--skip-build]
#
# Builds the cloud-dashboard/ Docker image and pushes it to ECR, for
# helm/cloud-analytics's Deployment to pull (see scripts/deploy-cloud-analytics.sh
# --dashboard-image). Modeled on scripts/build-hmi.sh, but EKS worker nodes
# (unlike the K3s edge nodes build-hmi.sh targets) have no side-load path —
# there's no `k3s ctr images import` equivalent for managed EKS containerd —
# so this pushes to a real registry (ECR) instead of an S3+SSM sideload.
#
# The dashboard image is shared across all slots (same code, per-slot config
# comes from env vars/Secrets at deploy time) — one push per code change, not
# per slot.
set -euo pipefail

SKIP_BUILD=false
REPO_NAME="workshop-cloud-dashboard"
# Empty by default — resolved to an immutable git-short-SHA tag below (once
# REPO_ROOT is known) unless --tag overrides it. Tagging by commit SHA rather
# than the floating `:latest` means every code change produces a distinct,
# immutable tag: `helm upgrade` then references a new image and Kubernetes
# actually re-pulls, instead of a node continuing to serve a stale `:latest`
# under imagePullPolicy: IfNotPresent (the #197 bug). It also sidesteps the
# shared-`:latest` cross-slot trap in workshop/reference/repo-structure.md.
IMAGE_TAG=""
REGION="${AWS_DEFAULT_REGION:-us-east-1}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=true; shift ;;
    --tag)         IMAGE_TAG="$2"; shift 2 ;;
    --region)       REGION="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; echo "Usage: $0 [--skip-build] [--tag <tag>]" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Default to the current commit's short SHA (immutable per-change tag). Falls
# back to a timestamp if git rev-parse fails (e.g. building from a tarball with
# no .git) so the tag is still unique-per-build rather than the stale-prone
# shared `latest`.
if [[ -z "$IMAGE_TAG" ]]; then
  IMAGE_TAG=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
ECR_URI="${REGISTRY}/${REPO_NAME}"

echo ">>> ECR image  : ${ECR_URI}:${IMAGE_TAG}"

# ── 1. Ensure the ECR repository exists ──────────────────────────────────────
aws ecr describe-repositories --repository-names "$REPO_NAME" --region "$REGION" >/dev/null 2>&1 || \
  aws ecr create-repository --repository-name "$REPO_NAME" --region "$REGION" >/dev/null
echo ">>> ECR repository ${REPO_NAME} ready."

HAS_DOCKER=false
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  HAS_DOCKER=true
fi

if [[ "$SKIP_BUILD" == "true" ]]; then
  echo ">>> --skip-build: assuming ${ECR_URI}:${IMAGE_TAG} already exists in ECR."
else
  # ── 2. Build the image ─────────────────────────────────────────────────────
  # Uses buildah instead of `docker build` when no docker daemon is available
  # (e.g. this repo's CI/agent sandboxes) — buildah needs none. `--net=host`
  # is required under buildah's chroot isolation for the build's own network
  # calls (pnpm install) to resolve DNS.
  echo ">>> Building ${ECR_URI}:${IMAGE_TAG} from ./cloud-dashboard …"
  if [[ "$HAS_DOCKER" == "true" ]]; then
    docker buildx build --platform linux/amd64 -t "${ECR_URI}:${IMAGE_TAG}" "${REPO_ROOT}/cloud-dashboard" --load
  else
    echo ">>> No docker daemon available — building with buildah instead."
    buildah bud --storage-driver=vfs --isolation=chroot --net=host \
      -t "${ECR_URI}:${IMAGE_TAG}" "${REPO_ROOT}/cloud-dashboard"
  fi
  echo ">>> Image built."

  # ── 3. Push to ECR ──────────────────────────────────────────────────────────
  echo ">>> Logging in to ${REGISTRY} …"
  if [[ "$HAS_DOCKER" == "true" ]]; then
    aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
  else
    aws ecr get-login-password --region "$REGION" | \
      buildah --storage-driver=vfs login --username AWS --password-stdin "$REGISTRY"
  fi

  echo ">>> Pushing ${ECR_URI}:${IMAGE_TAG} …"
  if [[ "$HAS_DOCKER" == "true" ]]; then
    docker push "${ECR_URI}:${IMAGE_TAG}"
  else
    buildah --storage-driver=vfs push "${ECR_URI}:${IMAGE_TAG}"
  fi
  echo ">>> Push complete."
fi

echo ""
echo ">>> Deploy with:"
echo "      scripts/deploy-cloud-analytics.sh --deployment-id ws-slot00 --dashboard-image ${ECR_URI}:${IMAGE_TAG}"
