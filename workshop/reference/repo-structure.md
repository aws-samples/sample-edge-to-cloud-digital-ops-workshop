# Repository Structure

```
edge-digital-ops-workshop/
├── amplify/
│   ├── data/                       # Reusable AppSync JS resolvers (publishTelemetry, onTelemetry, healthCheck)
│   └── custom/
│       ├── platform-app.ts         # CDK app entry: platform + one set of nested stacks per slot (WORKSHOP_SLOTS)
│       ├── platform-stack.ts       # Shared VPCs, subnets, route tables, EKS, MSK, Firehose, S3
│       ├── auth-stack.ts           # Per-slot NestedStack: Cognito user pool + client + identity pool (was Amplify defineAuth)
│       ├── data-stack.ts           # Per-slot NestedStack: AppSync GraphQL API + JS resolvers (was Amplify defineData)
│       ├── schema.graphql          # AppSync SDL consumed by data-stack.ts
│       ├── participant-stack.ts    # Per-slot NestedStack: EC2, IoT, MSK topics, S3, AppSync Events
│       ├── orchestrator-app.ts     # CDK app entry for the deploy orchestrator (deployed once per account)
│       └── orchestrator-stack.ts   # CodeBuild project that runs the async fire-and-forget deploy
├── frontend/                       # Amplify-hosted cloud UI (fleet view, freshness panel)
├── cloud-dashboard/                # Session 4 analytics dashboard (Next.js) — built into a
│   │                               #   container image, runs on EKS via helm/cloud-analytics
│   ├── Dockerfile                  # Multi-stage build → workshop-cloud-dashboard ECR image
│   └── src/                        # Freshness + query-latency charts, SSE push / Athena poll routes
├── hmi/                            # Session 6 edge HMI (Next.js) — runs on K3s via helm/edge-stack
├── helm/                           # Helm charts for the in-cluster stacks
│   ├── cloud-analytics/            # Cloud tier: RisingWave, TimescaleDB (CNPG), Redpanda Connect, dashboard
│   └── edge-stack/                 # Edge tier: TimescaleDB, Redpanda, RisingWave, MinIO, HMI
├── risingwave/
│   └── ddl-cloud.sql               # RisingWave sources + MVs, applied by the chart's post-install Job
├── job-scripts/                    # IoT Job handler scripts (deployed to devices via Jobs)
│   ├── telemetry-v1.sh             # Session 2: shadow-driven telemetry config (starting point)
│   ├── telemetry-v2.sh             # Session 2: 3-decimal measurement precision (job exercise)
│   ├── deploy-k3s.sh               # Session 5: K3s cluster bootstrap
│   └── add-shadows.sh              # Session 3: app-deployment + device-health shadows
├── scripts/
│   ├── deploy-cloud-analytics.sh   # Session 4: stand up the cloud analytics stack for a slot
│   ├── build-cloud-dashboard.sh    # Build + push the cloud-dashboard image to ECR
│   ├── build-hmi.sh                # Build + side-load the HMI image to the edge K3s nodes
│   ├── create-workshop-user.sh     # Create Cognito user for the front-end UI
│   ├── grant-ci-access.sh          # Grant a CI/facilitator role EKS + Cognito access
│   ├── edge-kubeconfig.sh          # SSM port-forward kubectl to a slot's private K3s
│   ├── slot-list.sh                # SSM-backed active-slot set (/workshop/platform/active-slots) — source of truth
│   ├── post-deploy-slot.sh         # Per-slot post-deploy tail (device wait, shadow seed, K3s + analytics pre-warm)
│   ├── delete-slot.sh              # Remove ONE slot: runtime cleanup + drop from list + platform update
│   ├── trigger-deploy.sh           # Fire-and-forget: start the orchestrator CodeBuild, print the build-id handle
│   ├── poll-deploy.sh              # Poll a deploy handle (CodeBuild build id) to completion
│   ├── gen-amplify-outputs.sh      # Rebuild frontend/amplify_outputs.json from a slot's SSM params (replaces ampx output)
│   └── teardown.sh                 # Ordered per-slot runtime cleanup
├── e2e/                            # Doc-runner: executes annotated bash blocks in workshop/*.md
│   │                               #   against a live slot; the published docs ARE the test suite
│   ├── doc-runner.ts               # Block extraction, substitution, assert + freshness/latency capture
│   └── report.ts                   # Run-report rendering (per-file results + freshness/latency table)
├── workshop/                       # MkDocs source (this documentation)
│   ├── index.md
│   ├── javascripts/
│   │   └── deployment-id.js        # Client-side ?did= deployment ID substitution
│   ├── snippets/                   # Reserved for future snippet fragments (currently empty)
│   ├── 00-prerequisites/
│   ├── 01-observe/
│   ├── 02-control/
│   ├── 03-state/
│   ├── 04-analytics/
│   ├── 05-edge-infra/
│   ├── 06-hmi/
│   ├── 07-capstone/
│   └── reference/
├── docs/                           # Internal facilitator notes (not published)
│   ├── workshop-plan.md
│   ├── intent.md
│   └── notes/
├── requirements.txt                # Python deps for MkDocs (mkdocs-material)
└── mkdocs.yml                      # MkDocs configuration
```

## Two ways code reaches a slot

Not everything deploys the same way, and the difference is the single most common
source of "I changed the code but nothing changed on my slot" confusion. There are
two distinct mechanisms:

### 1. Infrastructure — synthesized from source at deploy time (`amplify/`, CDK)

The shared platform stack and every slot's nested stacks (Auth + Data +
Participant) under `amplify/custom/` are **synthesized directly from the
TypeScript** every time you run `pnpm run sandbox <slot>` or
`pnpm run sandbox:all <slots>`. There is now a **single deploy target** —
`WorkshopPlatformStack`, driven by the `WORKSHOP_SLOTS` list — rather than a
separate `ampx sandbox` backend per slot. Edit `participant-stack.ts`, re-run the
sandbox, and the change is live; there is no intermediate artefact to rebuild.
Because the slot list is authoritative, the deploy scripts union the requested
slots with the persisted active set in SSM (`scripts/slot-list.sh`) so bringing
up one slot never tears down the others.

### 2. In-cluster apps — pre-built container images (`cloud-dashboard/`, `hmi/`)

The Session 4 dashboard and the Session 6 HMI are **Next.js apps that run as
container images on Kubernetes**, not synthesized CDK. Editing their source under
`cloud-dashboard/src/` or `hmi/` does **nothing** on a slot until you rebuild the
image, push it, and roll the deployment. The Helm release points at an image tag in
ECR — it does not build from source.

The dashboard lifecycle, end to end:

```bash
# 1. Build the image from cloud-dashboard/ and push it to ECR.
#    Default tag is `latest`, and that tag is SHARED BY EVERY SLOT.
scripts/build-cloud-dashboard.sh

# 2. Roll the running Deployment so it pulls the new image.
#    deploy-cloud-analytics.sh runs `helm upgrade` with the dashboard image set.
scripts/deploy-cloud-analytics.sh ws-slot00
```

**The shared-`latest` trap.** Because `workshop-cloud-dashboard:latest` is one tag
shared across all slots, pushing it and rolling every slot ships your change to
*everyone* — including uncommitted, unreviewed work. To test a change on **one**
slot without touching the others, build a scoped tag and set it on just that slot's
Deployment:

```bash
# Build + push under a throwaway tag (never `latest`).
scripts/build-cloud-dashboard.sh --tag slot00-preview-$(git rev-parse --short HEAD)

# Point ONLY this slot's dashboard at it. Container name is `dashboard`.
kubectl set image deployment/cloud-analytics-dashboard \
  dashboard=<account>.dkr.ecr.<region>.amazonaws.com/workshop-cloud-dashboard:slot00-preview-<sha>
```

Once the change is reviewed and merged, rebuild+push `latest` and roll the slots
normally so the shared tag and the code agree again. The HMI follows the same
pattern via `scripts/build-hmi.sh` (which side-loads the image onto the edge K3s
nodes rather than pushing to ECR, since the edge cluster is private).
