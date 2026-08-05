# Design — Switch telemetry-agent updates from custom IoT Jobs to Package Deployments

**Date:** 2026-08-05
**Status:** Approved (design), pending spec review
**Scope:** telemetry-agent update flow only (Session 2 / "Control")

---

## Problem

The workshop updates the telemetry agent on edge devices via **custom IoT Jobs**:
a `.sh` handler is uploaded to S3, a custom job document (`runHandler` →
`run-script.sh`) is created against the `<slot>-devices` thing group, and the
handler script **hand-writes** the version into *two* device shadows:

- `device-config.reported.config_version` (app-level config version), and
- `$package.reported.telemetry-agent.version` (the reserved package shadow).

Meanwhile the Software Package Catalog (`<slot>-telemetry-agent`, versions
`1.0.0` / `2.0.0`) exists in CDK but is **purely decorative** — the versions are
`DRAFT`, have no attributes, and are referenced by nothing. The scripts have
marched the shadow to `4.0.0` by hand while the catalog stayed frozen at `2.0.0`.

Consequences observed:

- **Stale doc queries.** Console deep-links in `block-4-fleet-management.md`
  (and previously `block-3-fleet-indexing.md`) pin `config_version:2.0.0`, which
  now returns 0 devices because devices report `4.0.0`.
- **No single source of truth.** The catalog does not reflect what devices run;
  the `$package` shadow is written by an "in-house process" (the handler) that
  AWS explicitly warns against when Jobs could own it.

## Goal

Make telemetry-agent updates **real package deployments**: the catalog is the
source of truth, package versions are `PUBLISHED` and deployable, and IoT Jobs
**automatically** updates the reserved `$package` shadow on job success. The
custom-job teaching in Session 2 remains (a package deployment *is* still a job
underneath — a `create-job` with a `destinationPackageVersions` association).

Out of scope: converting the shadow-job (Session 3) or k3s-launch (Session 5)
flows; substitution-parameter-driven job documents (see "Rejected — Approach B").

---

## Key mechanism (verified against AWS docs + live account)

1. **`versionUpdateByJobsConfig`** is an **account-wide** setting
   (`iot:UpdatePackageConfiguration`). When enabled with a role that grants IoT
   Jobs `iot:UpdateThingShadow` on `$package`, a job whose
   `destinationPackageVersions` is set will update the thing's reserved named
   shadow automatically on **successful** completion.
   *Verified: account currently has `versionUpdateByJobsConfig.enabled = false`.*
2. **A package deployment updates only the `$package` shadow** —
   `telemetry-agent.version`. It does **not** touch
   `device-config.reported.config_version`. That app-level shadow stays owned by
   the handler script (the block-4 drift-detection exercise keys on it).
3. **Package versions must be `PUBLISHED`** to be deployable; attributes can only
   be set while `DRAFT`. *Verified: current catalog versions are `DRAFT`.*
4. **AWS explicitly warns** against hand-writing `$package` while Jobs is also
   configured to write it ("can cause inconsistencies") — so the handler's
   `$package` write must be **removed**, not left as a belt-and-suspenders.

Source docs:
- https://docs.aws.amazon.com/iot/latest/developerguide/preparing-jobs-for-service-package-catalog.html
- https://docs.aws.amazon.com/iot/latest/apireference/API_VersionUpdateByJobsConfig.html
- https://docs.aws.amazon.com/cli/v1/reference/iot/update-package-version.html

---

## Design

### 1. Platform stack (shared, account-wide) — `amplify/custom/platform-stack.ts`

Mirror the existing `FleetIndexingConfig` `AwsCustomResource` pattern
(platform-stack.ts:802) — the established way this repo sets account-wide IoT
config once for all slots.

- **New IAM role `IotJobsShadowUpdateRole`** — assumed by `iot.amazonaws.com`,
  granting `iot:UpdateThingShadow` (scoped to `$package` named-shadow ARNs where
  the resource type allows; `*` fallback documented inline if scoping proves
  infeasible, consistent with the existing IoT scoping rationale).
- **New `PackageConfig` `AwsCustomResource`** — `onCreate`/`onUpdate` call
  `Iot.updatePackageConfiguration` with
  `versionUpdateByJobsConfig = { enabled: true, roleArn: <IotJobsShadowUpdateRole> }`.
  `policy: fromSdkCalls(ANY_RESOURCE)` like the sibling resource.
  Consider an `onDelete` that sets `enabled:false` (or omit — account-wide
  teardown is not part of routine slot teardown; decide in plan).

*Rationale for platform stack:* the setting is account-global; a per-slot home
would be last-writer-wins and fragile (user confirmed platform-stack placement).

### 2. Participant stack (per-slot catalog) — `amplify/custom/participant-stack.ts`

Current: two attribute-less `DRAFT` versions (participant-stack.ts:419-427).

- **Add `attributes: { version: "<x.y.z>" }`** to each
  `CfnSoftwarePackageVersion`.
- **Publish the versions** so they are deployable. `CfnSoftwarePackageVersion`
  creates versions in `DRAFT`; publishing to `PUBLISHED` may require either a
  supported CFN property or a small custom-resource
  `iot:updatePackageVersion --action PUBLISH`. **Open implementation detail:**
  confirm whether the L1 exposes a publish/status property; if not, add a
  per-version `AwsCustomResource`. Record the chosen mechanism in the plan.
- **Extend the catalog to the versions the scripts actually roll out.** Scripts
  today report `2.0.0` (v2), `3.0.0` (v3), `4.0.0` (v4). At minimum the catalog
  must contain the version(s) a doc deploys via `destinationPackageVersions`
  (block-2 deploys v4 → `4.0.0`). Decide in the plan whether to register the
  full `1.0.0`–`4.0.0` set or only the versions referenced by docs; the catalog
  must not silently lag behind what a doc deploys.
- **No participant-role IAM change** — the role already grants `iot:*` on `*`
  (participant-stack.ts:1192), which covers `CreateJob` with
  `destinationPackageVersions`, `GetPackageVersion`, and `UpdatePackageVersion`.

### 3. Job scripts — `job-scripts/telemetry-v{2,3,4}.sh`

Each handler currently has a dedicated `update-thing-shadow --shadow-name
'$package'` block (v2: lines 70-77; v3: ~136; v4: ~136) **in addition to** the
`device-config` write.

- **Delete the `$package` `update-thing-shadow` block** in each script. IoT Jobs
  now owns that shadow via `destinationPackageVersions`.
- **Keep the `device-config.reported.config_version` write unchanged** — the
  drift-detection exercise (block-4) depends on it, and package deployment does
  not write it.
- **Note on `telemetry-v4.sh`:** block-2 step 1 *generates* v4 from v3 via `sed`.
  Removing the `$package` block from v3 means the generated v4 inherits the
  removal — consistent. The **committed** `job-scripts/telemetry-v4.sh` must be
  edited too so it matches what the doc's `sed` produces.
- Snippet tags (`--8<-- [start:job-handler]`) must still wrap valid content so
  `mkdocs build --strict` and the block-2 `bash -n` syntax assert pass.

### 4. Docs

**`workshop/02-control/block-2-iot-job.md`**
- Add `--destination-package-versions <versionArn>` to the `create-job` CLI
  (block-2:112) and reflect it in the console-based step 3.
  ARN form: `arn:aws:iot:<region>:<acct>:package/<slot>-telemetry-agent/version/4.0.0`,
  built with the `ws-slot00` / `000000000000` placeholders per the substitution
  rules.
- Add a short note: the catalog is the source of truth; on success IoT updates
  the `$package` shadow automatically (no hand-writing).
- Job document stays a `runHandler` on the S3 script (Approach A — no
  substitution parameters).
- Preserve existing `e2e:assert`s (including `jobSucceeds: true`).

**`workshop/02-control/block-4-fleet-management.md`**
- Fix stale `config_version:2.0.0` console links → `:*` (the original bug);
  de-pin the prose ("confirm all devices report `2.0.0`").
- Reword step 1 so the "packages 1.0.0/2.0.0" description reflects the now-real,
  **published** catalog and the fact that the `$package` shadow is written by the
  package deployment, not the handler.
- Keep each block's `e2e:assert`.

**Consistency sweep:** grep other docs (`block-3-fleet-indexing.md`,
`02-control/index.md`, `README.md`, `workshop/reference/repo-structure.md`) for
prose claiming the handler writes `$package`, or for stale pinned versions, and
reconcile. (block-3 was already de-pinned to `:*` / the combined table in prior
work.)

---

## Verification

- **Static:** `bash -n` on each edited script; `mkdocs build --strict` (snippet
  tags intact); `pnpm run build`/CDK synth for the two stacks.
- **Live (laptop credentials required):** a package change to the shared platform
  stack means the correct validation is a **platform + one-slot deploy**, then a
  doc-runner pass of `block-2-iot-job.md` and `block-4-fleet-management.md`
  against that slot. Confirm after the job:
  - `get-package-configuration` → `versionUpdateByJobsConfig.enabled == true`;
  - job reaches `SUCCEEDED`;
  - `$package.reported.telemetry-agent.version` == deployed version, **written by
    IoT** (handler no longer writes it);
  - `device-config.reported.config_version` still updated by the handler;
  - block-4 drift exercise still finds the drifted device.
- This is a live-AWS, long-running op → use the monitor-script hand-off pattern
  (CLAUDE.md); do **not** background it inside an agent turn.

## Rollout / safety

- Enabling `versionUpdateByJobsConfig` is account-wide and affects **all slots**.
  It is additive (no effect until a job sets `destinationPackageVersions`), so
  existing custom jobs elsewhere are unaffected until their docs opt in.
- Removing the handler's `$package` write is only safe **after** the account
  config + role are live; otherwise the `$package` shadow stops being updated at
  all. **Deploy ordering: platform stack first, then scripts/docs.** Note this in
  the plan as a hard sequence.

---

## Rejected alternatives

- **Approach B — full Software Package Catalog showcase** (attributes +
  `${aws:iot:package:...:attributes:s3Url}` substitution parameters injecting the
  artifact URL into a version-agnostic job doc). More faithful to large-fleet
  OTA, but adds moving parts that obscure the Session-2 teaching point.
  Over-scoped for a workshop block.
- **Approach C — keep custom job, only add `destinationPackageVersions`** without
  publishing versions or adding attributes. Smallest diff, but the catalog stays
  `DRAFT`/attribute-less — a half-measure that doesn't actually teach package
  deployments.

## Files touched (summary)

| File | Change |
|---|---|
| `amplify/custom/platform-stack.ts` | + `IotJobsShadowUpdateRole`, + `PackageConfig` custom resource |
| `amplify/custom/participant-stack.ts` | version attributes + publish + catalog version set |
| `job-scripts/telemetry-v2.sh` | remove `$package` shadow write |
| `job-scripts/telemetry-v3.sh` | remove `$package` shadow write |
| `job-scripts/telemetry-v4.sh` | remove `$package` shadow write (committed copy) |
| `workshop/02-control/block-2-iot-job.md` | `--destination-package-versions`, note |
| `workshop/02-control/block-4-fleet-management.md` | de-pin versions, reword step 1 |
| (sweep) other docs/README | reconcile stale `$package`-handler / version prose |
