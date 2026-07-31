# Roadmap & E2E Coverage Status

Maintainer-facing tracker for workshop build-out and end-to-end (doc-runner) test
coverage. Participant instructions live in the session docs; this page tracks the
work *behind* them. Keep it current as issues open, land, and close.

_Last updated: 2026-07-30._

## Testing model

`e2e/runner.ts` has been removed. The **doc-runner** (`e2e/doc-runner.ts` +
`e2e/doc-runner-cli.ts`) is now the sole end-to-end test: it extracts bash blocks
annotated with `<!-- e2e:assert {...} -->` from the published workshop docs and
executes them against a live slot, so the thing under test is the literal command a
participant copy-pastes.

```bash
cd e2e && npx tsx doc-runner-cli.ts workshop/02-control --deployment-id ws-slot00
```

Pass `--report-out <path>` (or set `E2E_REPORT_OUT`) to also persist the run
summary to a markdown file — replaces the old copy-paste-the-terminal habit.
A directory argument (default `e2e/reports/`) is named `YYYY-MM-DD-<slot>.md`;
stdout output is unchanged either way:

```bash
cd e2e && npx tsx doc-runner-cli.ts workshop --deployment-id ws-slot06 --report-out e2e/reports/
# => writes e2e/reports/2026-07-31-ws-slot06.md
```

### Personas — admin vs participant

The runner can execute a doc under one of two identities (`--persona` /
`E2E_PERSONA`), because a single doc (e.g. `04-analytics/block-1-deploy.md`)
interleaves cluster-scoped facilitator steps with namespace-scoped attendee steps:

| Persona | Credentials | Runs which blocks |
|---|---|---|
| _(unset, default)_ | calling principal, granted cluster access | **every** annotated block — unchanged `pnpm run e2e` |
| `admin` (`pnpm run e2e:admin`) | calling principal; `grant-ci-access.sh` grants it cluster-scoped EKS/Cognito access first | blocks tagged `"persona":"admin"` **plus** untagged blocks |
| `participant` (`pnpm run e2e:participant`) | **`aws` CLI → own (ambient) identity; `kubectl`/`helm` → `WorkshopParticipantRole-<slot>`** | blocks tagged `"persona":"participant"` **plus** untagged blocks |

A block opts into a persona with a `"persona"` key in its `e2e:assert` JSON
(`{"contains":"Ready","persona":"admin"}`); **omitting it means the block runs
under both**.

The participant persona models the real attendee identity split: an attendee
runs the AWS-CLI steps (`iot`, `s3`, `secretsmanager`, `athena`, …) as their own
workshop IAM user, and assumes `WorkshopParticipantRole-<slot>` **only for
`kubectl`** — that role is EKS-only (`eks:DescribeCluster` + a namespace-scoped
`AmazonEKSEditPolicy` access entry). The runner implements this by building a
throwaway kubeconfig whose exec plugin calls `aws eks get-token --role-arn
<participant-role>` and pointing `KUBECONFIG` at it; ambient creds stay in effect
for every plain `aws` call. It never injects the role's creds into the process
env. The doc's cluster-admin `update-kubeconfig` (Step 1 of block-1-deploy) is
tagged `persona:admin`, so it's skipped in the participant run and can't clobber
the role-scoped kubeconfig.

## Latest run — 2026-07-30 on `ws-slot06`: 47/66 blocks passed

Full doc-runner run against `ws-slot06` on 2026-07-30 (report:
`e2e/reports/2026-07-30-slot06.md`). **47/66 asserted blocks passed.** The 19 reds
fall into three buckets — two real defects and one test-runner precondition:

**1. Flink Iceberg sink not running (real defect) — #117 / #118**
- `01-observe/block-3-athena.md` block 2 **and** `02-control/block-5-observe.md`
  block 1 both fail with `ICEBERG_MISSING_METADATA: Metadata not found in metadata
  location for table workshop_telemetry.telemetry`. Same root cause: the Managed
  Flink app `workshop-iceberg-sink` **crash-loops back to `READY`** and never writes
  the Iceberg table metadata (`telemetry/` S3 prefix is empty). `FlinkAppAutoStart`
  fired but the job doesn\'t stay RUNNING. **#117**, blocked by **#118** (app has
  **no CloudWatch logging** attached → crash undiagnosable until logging is added).

**2. Docs still say "Hudi" (real defect) — #119**
- The archive tier was migrated MSK-Connect-Hudi → Managed-Flink-Iceberg
  (commits `63b1a30`, `7c6853c`/PR #82) but ~10 doc files still describe it as Hudi,
  including `reference/decisions.md`\'s now-inverted "Hudi over Iceberg" row. No Hudi
  component is deployed (`kafkaconnect list-connectors` → `[]`). Doc-only fix.

**3. EKS auth not granted to the test-runner role (precondition, NOT a defect) — FIXED**
- All of `04-analytics` (block-1-deploy 3/15, block-2-risingwave 0/2,
  block-4-timescaledb 0/2) failed with *"the server has asked for the client to
  provide credentials"* / port-4567 connection-refused. Cause: the local
  `admin/waltmayf-Isengard` role was **not** in `workshop-eks` access entries.
  (Participant roles already get a namespace-scoped `AmazonEKSEditPolicy` entry
  from the CDK — only a CI/facilitator role that didn\'t create the cluster is
  affected.) **Fixed**: `doc-runner-cli.ts` now runs `scripts/grant-ci-access.sh`
  for the calling role at startup (best-effort, skips participant roles, opt out
  with `E2E_SKIP_EKS_GRANT=true`). Verified: the auth error is gone; a fresh
  sequential run creates the `ws-slot06` namespace in block-1 before the later
  blocks query it. Not a workshop bug — no issue filed.
- `05-edge-infra/index.md` block 1 (docker build) is the **same local buildx/ECR
  artifact** as the #37 baseline — not a product defect.

> The #37 baseline (below) was on `ws-slot38` with the Flink sink healthy and CI
> EKS access pre-granted; #117/#119 are genuine regressions/drift to fix, while the
> 04-analytics reds here are just this run\'s missing EKS grant.

## Latest full-slot run — #37 release baseline

Against a **clean slot `ws-slot38`** on 2026-07-29 (all code fixes deployed:
#102 CreateGrant, #103 device-client restart; doc fixes from #105/#107/#108):
**65/66 asserted blocks pass.** The single red is `05-edge-infra/index.md`'s
docker build — a local buildx/ECR-login artifact (`public.ecr.aws` 403 on the
metadata HEAD; direct `docker pull` succeeds), not a product defect. This is the
release baseline that closed #37.

| Session | Result | Notes |
|---|---|---|
| 01-observe | ✅ | Athena/Glue green |
| 02-control | ✅ | iot-job 6/6 after #103 fix (notify-next race gone); fleet-indexing/management green |
| 03-state | ✅ | shadow-job + ui green |
| 04-analytics | ✅ 15/15 + 2/2 + 2/2 | after clearing shared-EKS capacity exhaustion (see ops note below) |
| 05-edge-infra | ✅ | k3s-launch 4/4, helm 4/4, verify 6/6; only `index.md` docker build red (local runner artifact) |
| 06-hmi | ✅ | |
| 07-capstone | ✅ | teardown block |

> **Ops note:** don't stack multiple slots' analytics workloads on the shared
> 2-node EKS at once — leftover namespaces pin both nodes at ~99% memory and new
> slots' RisingWave/TimescaleDB pods stay `Pending`. Delete stale `ws-slotNN`
> namespaces before a fresh analytics run.

## Session-4 analytics fixes (landed on `fix/analytics-storage-and-docrunner`)

The 04-analytics doc-runner went from **1/14 → all-paths-green** after fixing a
chain of infra + doc bugs, each verified live on a fresh test slot:

- **Storage tier never provisioned** — platform stack shipped no EBS CSI driver
  and no default `StorageClass`, so every PVC (TimescaleDB, RisingWave) stayed
  `Pending`. Fixed: install EBS CSI + OIDC audience in the platform stack
  (commit `9c919b0`); doc creates a `gp3` default `StorageClass` once per cluster.
- **MSK SCRAM secret never associated** — `batchAssociateScramSecret` returns
  HTTP 200 with per-secret failures in `UnprocessedScramSecrets[]` and never
  throws, so the `AwsCustomResource` reported success while every SASL/SCRAM
  login failed "invalid credentials". Fixed: Lambda-backed custom resource that
  polls `ListScramSecrets` and retries until association verifiably takes
  (`participant-stack.ts`).
- **MSK topics never created / MSK is VPC-private** — `PublicAccess: DISABLED`
  means `create-msk-topics.sh` can't run from a laptop. Fixed: block-1 doc now
  creates topics from an in-cluster `python:3.12-slim` pod with `kafka-python`
  (the JVM Kafka CLI OOMs on the memory-constrained nodes).
- **block-4 wrong service/db names** — connected to `timescaledb-rw`/`telemetry`;
  actual deployed names are `timescaledb-cloud-rw`/`edge` with a CNPG-generated
  password. Fixed the connect block + documented the local port-5432 collision
  and the `psql`-client prerequisite (commit `a70a619`).
- **RisingWave DDL assert mismatch** — RisingWave emits `CREATE_MATERIALIZED_VIEW`
  (underscores), not the spaced PostgreSQL form; asserts corrected in block-1 and
  block-2 (commit `e740f52`).
- **doc-runner placeholder substitution** — assert *expected* values weren't being
  run through the same `ws-slot00`/account substitution as the commands, and two
  host-only asserts were dropped (commit `5bec387`).

**#88 (closed)** — block-4 continuous aggregates now run for real. The cloud
"TimescaleDB" was plain `postgresql:16.3` (no timescaledb extension), so the CAGG
SQL couldn't run and referenced a nonexistent `telemetry_raw`/`cpu_pct` schema.
Fixed by keeping CNPG (operator owns HA/failover/backups) and swapping only the
*operand* image to a CNPG-compatible build with timescaledb baked in
(`ghcr.io/clevyr/cloudnativepg-timescale:16.4-ts2.16` — the official
`timescale/timescaledb-ha` tags are non-semver and fail CNPG's validator).
`postInitApplicationSQL` now `CREATE EXTENSION`, promotes `sensor_readings` to a
hypertable, and `ALTER TABLE ... OWNER TO workshop` (a CAGG needs ownership of the
source table). block-4 DDL rewritten against the real `sensor_readings` schema
with an e2e-asserted bash block; verified live (doc-runner 2/2).

## Milestones

- [x] Broaden `e2e:assert` annotation coverage to every session (#67)
- [x] Consolidate on doc-runner; remove `runner.ts` (#68 — closed, commit `2703c4e`)
- [x] Auto-start Managed Flink Iceberg sink on platform deploy (#69)
- [x] IAM-driven EKS access entries so participants can `helm`/`kubectl` (#70 item 1)
- [x] Fix `set -e` session-abort masking in doc-runner (#72)
- [x] Fix non-exported var threading between blocks (#74) — PR #76 (fleet-management 4/6 → 6/6)
- [x] Fix `deployment-summary.sh` CFN export names so per-slot fields populate (#36) — PR #78
- [x] SSH device-registration flow verified end-to-end; fixed stale fleet-provisioning runtime state on re-register (#38) — PR #79
- [x] Doc-runner exposed via `pnpm run test*` scripts, verified on a live slot (#23)
- [x] Resolve IoT Job block timeouts (#75/#103) — root cause was the aws-iot-device-client v1.10.0 fleet-provisioning jobs-subscription race, NOT a poll-ceiling bug. Fixed with a sentinel-guarded one-time post-provision restart (PR #105).
- [x] SSM port-forward path for session-5 K3s Helm blocks (#70 item 3) — `scripts/edge-kubeconfig.sh` (PR #109)
- [x] Provision EKS storage tier (EBS CSI + default `StorageClass`) so analytics PVCs bind
- [x] Reliable MSK SCRAM association via Lambda custom resource (was silently failing)
- [x] MSK SCRAM Lambda needs `kms:CreateGrant` on the SCRAM CMK — clean-slot deploy blocker exposed by #37 (PR #102)
- [x] VPC-private MSK topic creation from an in-cluster pod (04-analytics block 1)
- [x] Full-suite green-run sign-off on a fresh slot (#37) — **65/66 asserted blocks** on clean slot ws-slot38; sole red is a local buildx/ECR artifact, not a defect. CLOSED.

## Issue board

### Unblocked (actionable now)

| # | Type | Title | Status |
|---|---|---|---|
| ~~#23~~ | needs-review | Test doc runner | ✅ Closed — satisfied by `pnpm run test*` scripts, verified on ws-slot00 |
| ~~#29~~ | feature | 3-way data-freshness comparison (Athena/Iceberg tier) | ✅ Closed (PR #82) |
| ~~#31~~ | feature | Edge digital-ops backlog metric | ✅ Closed (PR #84) — Redpanda consumer-group lag scraped from `/public_metrics` |
| ~~#36~~ | ops | Populate per-slot fields in DEPLOYMENT_SUMMARY.md | ✅ Closed (PR #78) |
| ~~#38~~ | feature | Register a new IoT device over SSH | ✅ Closed (PR #79) — verified end-to-end |
| ~~#68~~ | e2e | Doc-runner as sole e2e test | ✅ Closed — `runner.ts`/`report-writer.ts` removed, scripts repointed, CLAUDE.md updated (commit `2703c4e`) |
| ~~#74~~ | bug/e2e | Block isolation drops non-exported shell vars → "unbound variable" | ✅ Closed (PR #76) |

### Closed since last update (2026-07-29 session)

| # | Title | Resolution |
|---|---|---|
| ~~#27~~ | Re-run shadow-job on slots, confirm green | ✅ Closed (blocker for #37) |
| ~~#28~~ | Exercise per-slot teardown verification | ✅ Closed — verified clean via live AWS API |
| ~~#37~~ | Full-suite green-run sign-off on a fresh slot | ✅ Closed — 65/66 on clean slot ws-slot38; sole red is a local buildx/ECR artifact |
| ~~#41~~ | Exercise platform teardown verification (Phase 9) | ✅ Closed — `WorkshopPlatformStack` DELETE_COMPLETE, all shared EKS/MSK/VPCs/peering/bucket/exports gone (verified live). Exposed #111. |
| ~~#70~~ | Doc-runner IAM + network path for sessions 03–05 | ✅ Closed (PR #109) — EKS access entry + Cognito grant applied live & codified in `grant-ci-access.sh`; K3s SSM path in `edge-kubeconfig.sh` |
| ~~#75~~ | IoT Job blocks time out | ✅ Closed — root cause was the device-client FP jobs-subscription race (#103), fixed in PR #105 |
| ~~#93~~ | block-4-verify names/ports | ✅ Closed (PR #101) |
| ~~#106~~ | block-4-verify EKS fall-through | ✅ Closed (PR #107) |
| ~~#111~~ | Platform teardown fails (Athena workgroup + S3 auto-delete) | ✅ Closed (PR #112) — Athena `recursiveDeleteOption`, S3 lifecycle rules, bucket pre-empty in `sandbox-delete-all.sh` |

### Remaining

| # | Type | Title | Status |
|---|---|---|---|
| #117 | bug/e2e | Athena queries fail: `ICEBERG_MISSING_METADATA` — Flink Iceberg sink crash-loops to READY (affects block-3-athena + block-5-observe) | 🔴 Open — **blocked by #118** |
| #118 | bug/infra | Managed Flink Iceberg sink has no CloudWatch logging — crash-loop undiagnosable | 🔴 Open — blocker for #117 |
| #119 | docs | Docs still say Hudi; deployment migrated to Flink→Iceberg (~10 files, incl. inverted `decisions.md` row) | 🔴 Open — doc-only |

Opened 2026-07-30 from the `ws-slot06` run above. #117 is blocked by #118 (native
GitHub relationship set); the doc-wide Hudi→Iceberg wording was split out to #119.
The shared platform is currently deployed (`ws-slot06`); the earlier note about
teardown (#41) still holds for a from-scratch run.

> GitHub's native issue-relationships feature is the source of truth for
> blocked-by/blocking (see `CLAUDE.md`). This table is a convenience mirror —
> re-derive it from the API when in doubt.
