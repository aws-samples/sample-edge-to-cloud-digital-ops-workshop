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

`sandbox:all` deploys the shared VPCs + EKS cluster once, then fans out one Amplify sandbox per slot in parallel. Cold deploy takes 45–60 minutes (MSK and EKS dominate). Deploy the night before.

To deploy a single slot for testing:

```bash
pnpm run sandbox ws-slot00
```

After all sandboxes finish, `scripts/deployment-summary.sh` runs automatically and writes **`DEPLOYMENT_SUMMARY.md`** in the repo root. It lists every slot's Deployment ID, workshop URL, S3 bucket, AppSync endpoints, and quick-command recipes.

To regenerate it manually at any time:

```bash
scripts/deployment-summary.sh ws-slot00 ws-slot01 ws-slot02
```

### Smoke tests

```bash
WORKSHOP_TEST_SLOT=ws-slot00 node scripts/smoke-test.mjs
```

Verifies: `amplify_outputs.json`, Cognito user pool, IoT provisioning template, S3 bucket, Athena workgroup, IoT topic rule, and 3 running EC2 instances.

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

```bash
scripts/teardown.sh ws-slot00
```

Removes IoT things, EC2 instances, SCRAM secrets, S3 objects, Athena workgroup, and SSM parameters for the slot. The shared VPCs and EKS cluster are preserved.

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
  backend.ts              # Amplify Gen 2 entry point; wires CDK stacks
  auth/resource.ts        # Cognito user pool definition
  custom/
    platform-stack.ts     # Shared VPCs (workshop-edge, workshop-cloud)
    participant-stack.ts  # Per-slot resources: EC2, IoT, MSK, S3, AppSync Events

job-scripts/
  telemetry-v1.sh         # Shadow-driven telemetry config, integer-precision metrics (starting point)
  telemetry-v2.sh         # Session 2 job exercise: 3-decimal measurement precision
  add-shadows.sh          # Deploys app-deployment and device-health shadow timers
  deploy-k3s.sh           # Installs K3s server/agent, writes kubeconfig to SSM

scripts/
  create-workshop-user.sh # Creates a Cognito participant user
  smoke-test.mjs          # Post-deploy verification
  teardown.sh             # Per-slot resource cleanup

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