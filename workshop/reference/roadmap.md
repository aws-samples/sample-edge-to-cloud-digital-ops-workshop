# Roadmap & E2E Coverage Status

Maintainer-facing tracker for workshop build-out and end-to-end (doc-runner) test
coverage. Participant instructions live in the session docs; this page tracks the
work *behind* them. Keep it current as issues open, land, and close.

_Last updated: 2026-07-27._

## Testing model

`e2e/runner.ts` has been removed. The **doc-runner** (`e2e/doc-runner.ts` +
`e2e/doc-runner-cli.ts`) is now the sole end-to-end test: it extracts bash blocks
annotated with `<!-- e2e:assert {...} -->` from the published workshop docs and
executes them against a live slot, so the thing under test is the literal command a
participant copy-pastes.

```bash
cd e2e && npx tsx doc-runner-cli.ts workshop/02-control --deployment-id ws-slot00
```

## Latest full-slot run

Against live `ws-slot00` on 2026-07-27, after merging #67/#68/#69/#70/#72:

| Session | Result | Notes |
|---|---|---|
| 01-observe | ✅ 2/2 | Athena/Glue green once Flink sink runs (#69) |
| 02-control | ⚠️ 17/24 | fleet-indexing 6/6; failures are #74 (unbound vars) + #75 (job timeout) |
| 03-state | ⚠️ 3/5 | failures are #74 + #75 |
| 04-analytics | ✅ 18/18 (verified paths) | up from 1/14; fixed storage tier, MSK SCRAM association, VPC-private topic creation, local `psql` prereq, RisingWave DDL asserts. See "Session-4 fixes" below. |
| 05-edge-infra | ⛔ unreachable | K3s on VPC-private IP; needs SSM port-forward (#70 item 2) |
| 06-hmi | ✅ 2/2 | |
| 07-capstone | ✅ 1/1 | teardown block |

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
- [ ] Resolve IoT Job block timeouts (#75) — diagnosed: flapping MQTT on one device (NAT idle-timeout suspected), not a poll-ceiling bug
- [ ] SSM port-forward path for session-5 K3s Helm blocks (#70 item 2)
- [x] Provision EKS storage tier (EBS CSI + default `StorageClass`) so analytics PVCs bind
- [x] Reliable MSK SCRAM association via Lambda custom resource (was silently failing)
- [x] VPC-private MSK topic creation from an in-cluster pod (04-analytics block 1)
- [ ] Full-suite green-run sign-off on a fresh slot (#37)

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

### Remaining — all require a live deployment / operator action (no code change)

Every open issue below needs an active AWS slot or manual operator step; none is
completable as a pure code change:

| # | Title | What it needs |
|---|---|---|
| #75 | IoT Job blocks time out at 900s | Diagnosed as flapping MQTT on one device (NAT idle-timeout suspected). Needs live-device debugging / a re-run to confirm. |
| #70 | Doc-runner IAM + network path for sessions 03–05 | Item 2: SSM port-forward path for session-5 K3s Helm blocks — needs CI-role IAM change validated against a live cluster. |
| #41 | Exercise platform teardown verification | **Now unblocked** (all of #29,#30,#31,#33,#35,#36,#38,#40 closed). Needs a live platform to run `scripts/teardown.sh` + `pnpm run sandbox:delete-all`. |
| #37 | Full-suite green-run sign-off on a fresh slot | Blocked by #27, #28, #75. A release-gate run on a fresh slot. |
| #27 | Re-run shadow-job on slots 01/02/03, confirm green | Live-slot job re-run (blocks #37). |
| #28 | Exercise per-slot teardown verification | Live-slot teardown run. |

> GitHub's native issue-relationships feature is the source of truth for
> blocked-by/blocking (see `CLAUDE.md`). This table is a convenience mirror —
> re-derive it from the API when in doubt.
