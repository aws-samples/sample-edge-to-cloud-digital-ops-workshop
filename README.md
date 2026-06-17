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
pnpm install
WORKSHOP_SLOT_COUNT=10 npx ampx sandbox --once
```

Cold deploy takes 45–60 minutes (MSK and EKS dominate). Deploy the night before.

To deploy a single slot for testing:

```bash
WORKSHOP_SLOT_COUNT=1 npx ampx sandbox --once
```

After all sandboxes finish, `scripts/deployment-summary.sh` runs automatically and writes **`DEPLOYMENT_SUMMARY.md`** in the repo root. It lists every slot's Deployment ID, S3 bucket, MSK ARN, AppSync endpoints, and secret ARNs, plus ready-to-run commands for smoke tests, user creation, and teardown.

To regenerate it manually at any time:

```bash
scripts/deployment-summary.sh ws-slot00 ws-slot01 ws-slot02
```

### Smoke tests

```bash
WORKSHOP_TEST_SLOT=ws-slot00 node scripts/smoke-test.mjs
```

Verifies: `amplify_outputs.json`, Cognito user pool, IoT provisioning template, S3 bucket, Athena workgroup, IoT topic rule, and 3 running EC2 instances.

### Create a participant Cognito user

```bash
scripts/create-workshop-user.sh ws-slot00 participant@example.com
```

### Teardown

```bash
scripts/teardown.sh ws-slot00
```

Removes IoT things, EC2 instances, MSK cluster, S3 objects, Athena workgroup, and SSM parameters for the slot. VPCs are preserved.

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
  telemetry-v2.sh         # Updates telemetry to 1 Hz, adds net metrics, updates shadow
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