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
| 04-analytics | ⚠️ 10/17 | up from 1/14 after EKS access (#70); remainder = local `psql`, RisingWave frontend (#29) |
| 05-edge-infra | ⛔ unreachable | K3s on VPC-private IP; needs SSM port-forward (#70 item 2) |
| 06-hmi | ✅ 2/2 | |
| 07-capstone | ✅ 1/1 | teardown block |

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
