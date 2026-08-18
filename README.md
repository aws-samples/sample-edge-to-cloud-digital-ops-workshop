# Edge Digital Operations Workshop

A hands-on AWS workshop teaching real-time IoT data pipelines for industrial edge deployments. Participants instrument simulated edge devices, route telemetry through a cloud pipeline, and compare the freshness and scaling characteristics of different data stores side-by-side.

**Format:** 7 weekly sessions × 4 hours  
**Audience:** Engineers familiar with AWS console and basic Linux

---

## What Participants Build

```
Edge EC2 (×3 per slot)
  └─ IoT Device Client
       └─ MQTT → IoT Core
            ├─ IoT Rules → AppSync Events API → browser (live push, no DB)
            └─ IoT Rules → S3 (telemetry landing)

Cloud (EKS)
  ├─ Redpanda Connect  →  MSK  →  TimescaleDB  (pump rate CAGG)
  └─ Next.js frontend  ←  AppSync Events
```

The **data freshness comparison panel** is the workshop's centrepiece: three panels showing the same pump rate metric — raw push via AppSync Events (~10–80 ms), TimescaleDB CAGG query-on-demand, and a static Hudi/Athena reference — making the architectural tradeoffs directly observable.

---

## Prerequisites

- AWS account with admin credentials
- Node.js 22 (`nvm use 22`)
- pnpm (`npm install -g pnpm`)
- AWS CLI v2 configured

---

## Admin Deploy (run once before Session 1)

```bash
# 1. Install dependencies
pnpm install

# 2. Deploy the shared platform stack + all participant slots
pnpm run sandbox:all ws-slot00 ws-slot01 ws-slot02 ws-slot03 ws-slot04 \
  ws-slot05 ws-slot06 ws-slot07 ws-slot08 ws-slot09
```

`sandbox:all` runs a **single** `cdk deploy` of `WorkshopPlatformStack`, which brings up the shared VPCs + EKS + MSK once and, as **nested stacks**, every slot's Auth + Data + Participant resources (driven by the `WORKSHOP_SLOTS` list). It then runs the per-slot post-deploy tail (`scripts/post-deploy-slot.sh`) in parallel. Cold deploy takes 45–60 minutes (MSK and EKS dominate). Deploy the night before.

To deploy a single slot for testing:

```bash
pnpm run sandbox ws-slot00
```

`sandbox` unions the slot into the persisted active-slot set (`/workshop/platform/active-slots`, see `scripts/slot-list.sh`) and re-deploys the one platform stack — so adding a slot never tears down the others.

### Async, fire-and-forget deploy (optional)

For a 45–60 min deploy you usually don't want to hold a terminal (or a GitHub Actions runner) open. A cloud-side CodeBuild orchestrator runs the deploy for you and returns a pollable handle immediately.

```bash
# One-time per account: provision the orchestrator CodeBuild project.
npx cdk deploy --app "npx tsx amplify/custom/orchestrator-app.ts" \
  WorkshopDeployOrchestrator \
  -c repoCloneUrl=https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop.git

# Trigger a deploy and get back a build-id handle (returns in seconds).
scripts/trigger-deploy.sh ws-slot00 ws-slot01

# Poll the handle to completion from your laptop.
scripts/poll-deploy.sh <build-id>
```

The GitHub `deploy.yml` workflow (`workflow_dispatch`) does the same via OIDC — it only *triggers* the orchestrator and exits, posting the build handle + a CodeBuild console link to the job summary. (CodeBuild needs a one-time GitHub source credential to clone the repo.)

After all sandboxes finish, `scripts/deployment-summary.sh` runs automatically and writes **`DEPLOYMENT_SUMMARY.md`** in the repo root. It lists every slot's Deployment ID, workshop URL, S3 bucket, AppSync endpoints, and quick-command recipes.

To regenerate it manually at any time:

```bash
scripts/deployment-summary.sh ws-slot00 ws-slot01 ws-slot02
```

### Smoke tests

```bash
WORKSHOP_TEST_SLOT=ws-slot00 node scripts/smoke-test.mjs
```

Verifies: the slot's `/workshop/<id>/graphql-endpoint` SSM param, Cognito user pool, IoT provisioning template, S3 bucket, Athena workgroup, IoT topic rule, and 3 running EC2 instances.

### End-to-end tests

The e2e suite is a doc-runner: it extracts every bash block annotated with `<!-- e2e:assert {...} -->` in `workshop/*.md` and runs it against a live slot, so the published docs are themselves the test suite.

```bash
# Run every workshop doc against a slot (defaults to ws-e2e-test)
WORKSHOP_TEST_SLOT=ws-slot00 pnpm run e2e

# Run a single doc file against a slot
cd e2e && pnpm test:doc-runner -- workshop/02-control/block-2-iot-job.md

# Target a specific slot explicitly
cd e2e && pnpm test:doc-runner -- workshop --deployment-id ws-slot00
```

The slot must already be deployed (`pnpm run sandbox ws-slot00`). Blocks that would tear down shared platform infrastructure are annotated `<!-- e2e:platform-teardown -->` and are refused unless you pass `pnpm run e2e:delete-platform-stack` (or `E2E_DELETE_PLATFORM_STACK=true`) — a normal run never destroys the shared VPC/EKS/MSK.

### Create a participant Cognito user

```bash
scripts/create-workshop-user.sh ws-slot00 participant@example.com
```

### Teardown

Because a slot's resources are now **nested** inside the single `WorkshopPlatformStack` (no per-slot top-level stack), removing one slot is a platform *update*, not an independent `cdk destroy`:

```bash
# Remove ONE slot: runtime cleanup, drop it from the active-slot set, then
# re-deploy the platform so CFN deletes that slot's nested stacks. Other slots
# and all shared infra (VPCs, EKS, MSK) are preserved.
scripts/delete-slot.sh ws-slot00           # or: pnpm run sandbox:delete (uses WORKSHOP_DEPLOYMENT_ID)

# Tear down EVERYTHING (all slots + shared platform):
pnpm run sandbox:delete-all                # uses the persisted active-slot set if no args
```

`scripts/teardown.sh ws-slot00` still exists and does only the **runtime-artefact** cleanup (self-registered IoT things/certs, the slot's SCRAM secret + topics on the shared MSK cluster, the EKS namespace, K3s SSM params). `delete-slot.sh` calls it first, then does the platform update — run `teardown.sh` on its own only when you want to reclaim runtime state without changing the deployed slot set.

---

## Workshop Docs (Local Preview)

The workshop instructions live in `workshop/` and are built with [MkDocs Material](https://squidfunk.github.io/mkdocs-material/).

```bash
# One-time setup (recommended: use a virtual environment)
python3 -m venv .venv
source .venv/bin/activate
pip install mkdocs-material pymdown-extensions

# Start the dev server with live reload
mkdocs serve
```

Open `http://localhost:8000`. The site rebuilds automatically whenever you save a file in `workshop/` or `mkdocs.yml`.

### Publishing to GitHub Pages

The live site at `https://aws-samples.github.io/sample-edge-to-cloud-digital-ops-workshop/` is updated automatically — just push to `main`:

```bash
git add workshop/ mkdocs.yml   # stage your changes
git commit -m "update labs"
git push upstream main
```

The `deploy-docs.yml` workflow runs `mkdocs gh-deploy` and Pages updates within ~30 seconds. **Do not run `mkdocs gh-deploy` locally** — it would publish uncommitted content and diverge from the repo.

---

## Repository Layout

```
amplify/
  data/                   # Reusable AppSync JS resolvers (publishTelemetry, onTelemetry, healthCheck)
  custom/
    platform-app.ts       # CDK app entry: platform + one set of nested stacks per slot (WORKSHOP_SLOTS)
    platform-stack.ts     # Shared VPCs (workshop-edge, workshop-cloud), EKS, MSK, Firehose, S3
    auth-stack.ts         # Per-slot NestedStack: Cognito user pool + client + identity pool
    data-stack.ts         # Per-slot NestedStack: AppSync GraphQL API + JS resolvers
    schema.graphql        # AppSync SDL consumed by data-stack.ts
    participant-stack.ts  # Per-slot NestedStack: EC2, IoT, MSK, S3, AppSync Events
    orchestrator-app.ts   # CDK app entry for the async deploy orchestrator (once per account)
    orchestrator-stack.ts # CodeBuild project that runs the fire-and-forget deploy

job-scripts/
  telemetry-v1.sh         # Shadow-driven telemetry config, integer-precision metrics (starting point)
  telemetry-v2.sh         # Not committed — participants generate it in the Session 2 job exercise
                          # (3-decimal measurement precision); see workshop/02-control/block-2-iot-job.md
  add-shadows.sh          # Deploys app-deployment and device-health shadow timers
  deploy-k3s.sh           # Installs K3s server/agent, writes kubeconfig to SSM

scripts/
  create-workshop-user.sh # Creates a Cognito participant user
  smoke-test.mjs          # Post-deploy verification
  slot-list.sh            # SSM-backed active-slot set (source of truth for WORKSHOP_SLOTS)
  post-deploy-slot.sh     # Per-slot post-deploy tail (device wait, shadows, K3s + analytics pre-warm)
  delete-slot.sh          # Remove one slot: runtime cleanup + drop from list + platform update
  gen-amplify-outputs.sh  # Rebuild frontend/amplify_outputs.json from a slot's SSM params (replaces ampx output)
  trigger-deploy.sh       # Fire-and-forget: start the orchestrator CodeBuild, print the handle
  poll-deploy.sh          # Poll a deploy handle (CodeBuild build id) to completion
  teardown.sh             # Per-slot runtime resource cleanup

docs/
  workshop-plan.md        # Full session-by-session workshop plan
```

---

## Per-Slot Resources

Each participant slot (`ws-slot00` … `ws-slot09`) gets an isolated set of resources:

| Resource | Details |
|---|---|
| 3× EC2 t3.medium | IoT Device Client; fleet provisioning by claim cert |
| IoT Provisioning Template | Pre-provisioning Lambda validates EC2 instance before registering Thing |
| MSK Provisioned cluster | `kafka.t3.small` × 2 brokers, SASL/SCRAM |
| AppSync Events API | IoT Rules HTTP action publishes directly; browser subscribes via WebSocket |
| S3 bucket | Telemetry landing (`telemetry/`) + Athena results (`athena-results/`) |
| Athena workgroup | Engine v3; queries the S3 telemetry landing |
| Secrets Manager secret | Claim cert for IoT fleet provisioning |

Two VPCs (`workshop-edge` `10.0.0.0/16`, `workshop-cloud` `10.1.0.0/16`) are shared across all slots — one set per account regardless of slot count.

---

## Data Pipeline

```
Device MQTT publish
  │
  ├─► IoT Rules → AppSync Events API → browser WebSocket
  │     (raw push; no database; ~10–80 ms device-to-browser)
  │
  └─► IoT Rules → S3 (telemetry landing)
        │
        └─► Redpanda Connect → MSK → TimescaleDB
              (pump rate CAGG; queried on each AppSync Event)
```

TimescaleDB is the primary operational data store. Its continuous aggregate (`pump_rate_10s`) is queried on demand each time an AppSync Event arrives at the browser, keeping the UI current without a persistent database connection.

---

## Key Design Decisions

**IoT Rules → AppSync Events (not Lambda).** The IoT Rules Engine HTTP action posts directly to the AppSync Events endpoint with SigV4 signing. No Lambda hop means no batch-window latency and no cold start risk on the live-push path.

**TimescaleDB as the edge and cloud data store.** TimescaleDB runs both at the edge (powers operational dashboards for the frac fleet) and in the cloud EKS cluster. Redpanda Connect fans data from MSK into the cloud TimescaleDB. If cloud connectivity is lost, the edge TimescaleDB is the system of record; Redpanda's buffer is expendable and can be backfilled from the edge TimescaleDB on reconnect.

**AppSync Events as the clock signal.** Rather than holding persistent `LISTEN/NOTIFY` connections from the browser to TimescaleDB, the browser receives an AppSync Event and uses it as the trigger to fire a regular HTTP request for the latest CAGG result. The database connection is stateless and pooled.