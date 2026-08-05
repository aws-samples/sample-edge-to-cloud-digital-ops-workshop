# Package-Deployment telemetry-agent Updates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the telemetry-agent update flow from opaque custom IoT Jobs to real Software Package deployments, so the catalog is the source of truth and IoT auto-updates the reserved `$package` shadow on job success.

**Architecture:** Enable account-wide `versionUpdateByJobsConfig` (+ an IoT-Jobs shadow-update IAM role) once in the shared platform stack; publish per-slot catalog versions with a `version` attribute; drop the handler scripts' hand-written `$package` shadow write; add `--destination-package-versions` to the block-2 `create-job` flow. The `device-config.reported.config_version` shadow stays owned by the handler script (the block-4 drift exercise depends on it).

**Tech Stack:** AWS CDK (Amplify Gen 2 wrapping raw CDK), TypeScript, `AwsCustomResource`, IoT Software Package Catalog, IoT Jobs, MkDocs, bash job handlers, `e2e/doc-runner.ts`.

## Global Constraints

- **Deploy ordering is a hard sequence:** platform stack (account config + role) MUST be live BEFORE the scripts drop their `$package` write. Otherwise `$package` stops updating entirely. Tasks are ordered to respect this; do not reorder Task 4/5 before Task 1–2 land in a deploy.
- **Package versions are created in `DRAFT`; `AWS::IoT::SoftwarePackageVersion` has NO status/publish property** (confirmed via AWS docs). Publishing requires the `UpdatePackageVersion` API (`--action PUBLISH`) → an `AwsCustomResource`.
- **Attributes can only be set while a version is `DRAFT`.** Set attributes at version-create time (CFN prop), publish after.
- **Do NOT hand-write `$package` while Jobs also writes it** — AWS warns this causes inconsistencies. The handler's `$package` write must be removed, not left in.
- **Placeholders in docs:** literal `ws-slot00` (slot) and `000000000000` (account) only — never a real value. Substitution is client-side (see CLAUDE.md).
- **Snippet tags must stay valid:** `--8<-- [start:job-handler]` / `[end:job-handler]` regions must wrap runnable bash so `mkdocs build --strict` and the block-2 `bash -n` assert pass.
- **Package manager:** `pnpm`, never `npm`.
- **The only telemetry version any doc deploys via a real job is `4.0.0`** (block-2 deploys `telemetry-v4.sh`). The catalog must contain `4.0.0` published.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `amplify/custom/platform-stack.ts` | Shared account-wide infra | + `IotJobsShadowUpdateRole`, + `PackageConfig` custom resource |
| `amplify/custom/participant-stack.ts` | Per-slot resources incl. package catalog | version attributes + publish custom resource + version set |
| `job-scripts/telemetry-v2.sh` | Session-2 (v2) handler | remove `$package` write |
| `job-scripts/telemetry-v3.sh` | v3 handler (block-2 "starting point" for v4) | remove `$package` write |
| `job-scripts/telemetry-v4.sh` | committed v4 handler (must match doc's `sed` output) | remove `$package` write |
| `workshop/02-control/block-2-iot-job.md` | Create/deploy the job | `--destination-package-versions` + note; keep `sed` recipe consistent |
| `workshop/02-control/block-4-fleet-management.md` | Fleet mgmt / drift | de-pin versions, reword step 1 |
| (sweep) `README.md`, `workshop/reference/repo-structure.md`, `workshop/02-control/index.md` | prose | reconcile "handler writes `$package`" / stale versions |

---

## Task 1: Add IoT-Jobs shadow-update IAM role to the platform stack

**Files:**
- Modify: `amplify/custom/platform-stack.ts` (near the `FleetIndexingConfig` block, ~line 795–838)

**Interfaces:**
- Produces: a `Role` const `iotJobsShadowUpdateRole` whose `.roleArn` is consumed by Task 2.

- [ ] **Step 1: Add the role above the FleetIndexingConfig custom resource**

Insert before `new AwsCustomResource(this, "FleetIndexingConfig", {` (line 802). `Role`, `ServicePrincipal`, `PolicyStatement`, `Effect` are already imported (platform-stack.ts:16-23).

```typescript
    // ── IoT Jobs → reserved $package shadow auto-update ──────────────────────
    // Role IoT Jobs assumes to write the reserved named shadow ($package) when a
    // job with destinationPackageVersions completes successfully. Enabled
    // account-wide via the PackageConfig custom resource below. Account-wide, so
    // it lives in PlatformStack (one role covers all slots), mirroring
    // FleetIndexingConfig. Thing names are EC2 instance IDs (not slot-prefixed)
    // and carry no tags, so the shadow resource can't be scoped tighter than
    // thing/* — consistent with the participant role's IoT scoping rationale.
    const iotJobsShadowUpdateRole = new Role(this, "IotJobsShadowUpdateRole", {
      assumedBy: new ServicePrincipal("iot.amazonaws.com"),
      description: "Lets IoT Jobs update the reserved $package named shadow on job success",
    });
    iotJobsShadowUpdateRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["iot:UpdateThingShadow", "iot:GetThingShadow"],
      resources: [`arn:aws:iot:${this.region}:${this.account}:thing/*`],
    }));
```

- [ ] **Step 2: Verify Effect is imported**

Run: `grep -n "Effect" amplify/custom/platform-stack.ts | head -3`
Expected: `Effect` appears in the `aws-cdk-lib/aws-iam` import block. If not present, add it to that import (lines 16-23).

- [ ] **Step 3: Type-check**

Run: `cd /Users/waltmayf/Documents/repos/edge-digital-ops-workshop && pnpm exec tsc --noEmit -p amplify/tsconfig.json 2>&1 | grep -i "platform-stack" || echo "no platform-stack type errors"`
Expected: `no platform-stack type errors` (if no such tsconfig, use the repo's build command — see Task 3 note).

- [ ] **Step 4: Commit**

```bash
git add amplify/custom/platform-stack.ts
git commit -m "feat(iot): add IoT Jobs role to update \$package shadow on job success"
```

---

## Task 2: Enable account-wide versionUpdateByJobsConfig

**Files:**
- Modify: `amplify/custom/platform-stack.ts` (immediately after Task 1's role)

**Interfaces:**
- Consumes: `iotJobsShadowUpdateRole.roleArn` from Task 1.

- [ ] **Step 1: Add the PackageConfig custom resource**

Insert after the role (Task 1), before or after `FleetIndexingConfig` (both are account-wide siblings). Mirror the `AwsCustomResource` shape already used at platform-stack.ts:802.

```typescript
    // Enable IoT Jobs → $package shadow reporting account-wide. Once enabled, a
    // job whose destinationPackageVersions is set updates the thing's reserved
    // $package shadow automatically on success — so job handlers must NOT also
    // hand-write $package (AWS warns this causes version inconsistencies).
    // Account-wide setting, one custom resource for all slots (like
    // FleetIndexingConfig above).
    const packageConfig = new AwsCustomResource(this, "PackageConfig", {
      onCreate: {
        service: "Iot",
        action: "updatePackageConfiguration",
        parameters: {
          versionUpdateByJobsConfig: {
            enabled: true,
            roleArn: iotJobsShadowUpdateRole.roleArn,
          },
        },
        physicalResourceId: PhysicalResourceId.of("PackageConfig"),
      },
      onUpdate: {
        service: "Iot",
        action: "updatePackageConfiguration",
        parameters: {
          versionUpdateByJobsConfig: {
            enabled: true,
            roleArn: iotJobsShadowUpdateRole.roleArn,
          },
        },
        physicalResourceId: PhysicalResourceId.of("PackageConfig"),
      },
      // No onDelete: versionUpdateByJobsConfig is account-wide and not part of
      // routine slot teardown; leaving it enabled is harmless (no effect until a
      // job sets destinationPackageVersions).
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });
    // updatePackageConfiguration validates the role can be assumed by IoT →
    // ensure the role exists first.
    packageConfig.node.addDependency(iotJobsShadowUpdateRole);
```

- [ ] **Step 2: Confirm AwsCustomResource / AwsCustomResourcePolicy / PhysicalResourceId are imported**

Run: `grep -n "AwsCustomResource\|AwsCustomResourcePolicy\|PhysicalResourceId" amplify/custom/platform-stack.ts | head`
Expected: all three appear in imports (they already back `FleetIndexingConfig`).

- [ ] **Step 3: The custom resource's own Lambda needs `iot:UpdatePackageConfiguration` + `iam:PassRole`**

`fromSdkCalls(ANY_RESOURCE)` auto-generates `iot:updatePackageConfiguration` on `*`. But passing a role to a service requires `iam:PassRole`. Add it explicitly to the custom resource's role:

```typescript
    packageConfig.grantPrincipal.addToPrincipalPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["iam:PassRole"],
      resources: [iotJobsShadowUpdateRole.roleArn],
    }));
```

Note: `AwsCustomResource` exposes `grantPrincipal`. If the linter flags it, use `(packageConfig.node.tryFindChild(...))` fallback — but `grantPrincipal` is the documented accessor.

- [ ] **Step 4: Type-check**

Run: `cd /Users/waltmayf/Documents/repos/edge-digital-ops-workshop && pnpm run build 2>&1 | tail -20`
Expected: build succeeds (or the CDK synth step in the repo's build passes with no error referencing `platform-stack.ts`). See Task 3 for the exact build command if `pnpm run build` isn't the synth gate.

- [ ] **Step 5: Commit**

```bash
git add amplify/custom/platform-stack.ts
git commit -m "feat(iot): enable versionUpdateByJobsConfig account-wide in platform stack"
```

---

## Task 3: Determine the CDK synth/verify command (spike, no commit)

This repo builds via Amplify Gen 2. Before editing the participant stack, confirm how to synth/type-check so later tasks can verify.

- [ ] **Step 1: Find the build/synth entry**

Run:
```bash
cd /Users/waltmayf/Documents/repos/edge-digital-ops-workshop
cat package.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('scripts',{}), indent=2))"
ls amplify/ && cat amplify/custom/platform-app.ts 2>/dev/null | head -30
```
Expected: identify the script that runs `tsc`/`cdk synth` (e.g. a `build` or `synth` script, or `npx ampx sandbox --once`/`cdk synth` against `platform-app.ts`).

- [ ] **Step 2: Run a type-check to establish a green baseline**

Run the command found in Step 1 (e.g. `pnpm exec tsc --noEmit` or `npx cdk synth -a "npx tsx amplify/custom/platform-app.ts"`).
Expected: passes on the current tree. Record the exact command; use it as the "Type-check" step in Tasks 1, 2, 4, 5.

*(No commit — this is a discovery step. If Tasks 1–2 used a placeholder build command that turns out wrong, re-run their type-check with the confirmed command and amend if needed.)*

---

## Task 4: Give participant catalog versions attributes + publish them

**Files:**
- Modify: `amplify/custom/participant-stack.ts:414-427` (the Software Package Catalog block)

**Interfaces:**
- Consumes: nothing from prior tasks at synth time (account config is runtime).
- Produces: published, attributed package versions deployable via `destinationPackageVersions`.

- [ ] **Step 1: Replace the catalog block with attributed versions + a publish custom resource**

Current (participant-stack.ts:414-427) creates `softwarePackage` + two attribute-less versions. Replace with: the package, versions `1.0.0`–`4.0.0` each carrying a `version` attribute, and one `AwsCustomResource` per version publishing it. `CfnSoftwarePackageVersion`, `AwsCustomResource`, `AwsCustomResourcePolicy`, `PhysicalResourceId`, `PolicyStatement`, `Effect` are already imported.

```typescript
    // ── Software Package Catalog ─────────────────────────────────────────────
    // The telemetry-agent package is the source of truth for what version each
    // device runs. Versions carry a `version` attribute; a job with
    // destinationPackageVersions pointed at one of these publishes it into the
    // device's reserved $package shadow automatically (see PackageConfig in the
    // platform stack). Only 4.0.0 is deployed by a workshop doc today
    // (02-control/block-2 → telemetry-v4.sh); the lower versions give the
    // catalog a realistic version history for the fleet-management block.
    const softwarePackage = new CfnSoftwarePackage(this, "TelemetryAgentPackage", {
      packageName: `${deploymentId}-telemetry-agent`,
    });

    const telemetryAgentVersions = ["1.0.0", "2.0.0", "3.0.0", "4.0.0"];
    for (const versionName of telemetryAgentVersions) {
      const logicalId = `TelemetryAgentV${versionName.split(".")[0]}`;
      const version = new CfnSoftwarePackageVersion(this, logicalId, {
        packageName: softwarePackage.ref,
        versionName,
        attributes: { version: versionName },
      });
      version.addDependency(softwarePackage);

      // CFN creates package versions in DRAFT and exposes no publish/status
      // property. A version must be PUBLISHED to be deployable via
      // destinationPackageVersions, so publish it with UpdatePackageVersion.
      const publish = new AwsCustomResource(this, `${logicalId}Publish`, {
        onCreate: {
          service: "Iot",
          action: "updatePackageVersion",
          parameters: {
            packageName: `${deploymentId}-telemetry-agent`,
            versionName,
            action: "PUBLISH",
          },
          physicalResourceId: PhysicalResourceId.of(`${logicalId}Publish`),
        },
        onUpdate: {
          service: "Iot",
          action: "updatePackageVersion",
          parameters: {
            packageName: `${deploymentId}-telemetry-agent`,
            versionName,
            action: "PUBLISH",
          },
          physicalResourceId: PhysicalResourceId.of(`${logicalId}Publish`),
        },
        policy: AwsCustomResourcePolicy.fromSdkCalls({
          resources: [
            `arn:aws:iot:${this.region}:${this.account}:package/${deploymentId}-telemetry-agent/version/${versionName}`,
          ],
        }),
      });
      publish.node.addDependency(version);
    }
```

- [ ] **Step 2: Type-check with the command from Task 3**

Run: (command established in Task 3)
Expected: passes, no error referencing `participant-stack.ts`.

- [ ] **Step 3: Confirm no logical-ID collision / dependency-order regression**

Run: `grep -n "TelemetryAgentV" amplify/custom/participant-stack.ts`
Expected: exactly the loop-generated IDs; no leftover `TelemetryAgentV1`/`TelemetryAgentV2` literals from the old block.

- [ ] **Step 4: Commit**

```bash
git add amplify/custom/participant-stack.ts
git commit -m "feat(iot): publish telemetry-agent catalog versions with version attribute"
```

---

## Task 5: Remove the hand-written `$package` shadow write from all three handlers

**Files:**
- Modify: `job-scripts/telemetry-v2.sh` (the `update-thing-shadow --shadow-name '$package'` block, lines 70-77)
- Modify: `job-scripts/telemetry-v3.sh` (same block, lines 130-137)
- Modify: `job-scripts/telemetry-v4.sh` (same block, lines 130-137)

**Interfaces:**
- Consumes: the account config from Tasks 1–2 must be deployed first (runtime dependency, not synth).
- Produces: handlers that write only `device-config`; `$package` is left to IoT Jobs.

- [ ] **Step 1: Remove the `$package` block in telemetry-v2.sh**

Delete these lines (v2, after the `device-config` write, before `echo "telemetry-v2 applied successfully"`):

```bash
aws iot-data update-thing-shadow \
  --region "$REGION" \
  --endpoint-url "https://$IOT_ENDPOINT" \
  --thing-name "$INSTANCE_ID" \
  --shadow-name '$package' \
  --cli-binary-format raw-in-base64-out \
  --payload '{"state":{"reported":{"telemetry-agent":{"version":"2.0.0"}}}}' \
  /dev/null
```

Leave the preceding `device-config` `update-thing-shadow` block and the trailing `echo ... exit 0` intact. Optionally add a one-line comment where it was:

```bash
# NOTE: $package shadow is updated automatically by IoT Jobs (destinationPackageVersions) — do not write it here.
```

- [ ] **Step 2: Remove the identical block in telemetry-v3.sh**

Same deletion; the payload line reads `"version":"3.0.0"`. Keep the same NOTE comment.

- [ ] **Step 3: Remove the identical block in telemetry-v4.sh**

Same deletion; the payload line reads `"version":"4.0.0"`. Keep the same NOTE comment.

- [ ] **Step 4: Syntax-check all three**

Run:
```bash
cd /Users/waltmayf/Documents/repos/edge-digital-ops-workshop
for f in telemetry-v2 telemetry-v3 telemetry-v4; do bash -n job-scripts/$f.sh && echo "$f OK"; done
```
Expected: `telemetry-v2 OK` / `telemetry-v3 OK` / `telemetry-v4 OK`.

- [ ] **Step 5: Verify the snippet-tagged region is still valid & no `$package` write remains**

Run:
```bash
cd /Users/waltmayf/Documents/repos/edge-digital-ops-workshop
grep -c "shadow-name '\$package'" job-scripts/telemetry-v2.sh job-scripts/telemetry-v3.sh job-scripts/telemetry-v4.sh
grep -c "config_version" job-scripts/telemetry-v2.sh job-scripts/telemetry-v3.sh job-scripts/telemetry-v4.sh
```
Expected: first grep → `0` for all three; second grep → `≥1` for all three (device-config write retained).

- [ ] **Step 6: Confirm block-2's `sed` recipe still regenerates v4 from v3 cleanly**

block-2 step 1 generates v4 via `sed 's/%d/%.3f/g; s/3\.0\.0/4.0.0/g; s/telemetry-v3/telemetry-v4/g' job-scripts/telemetry-v3.sh > job-scripts/telemetry-v4.sh`. With the `$package` block removed from v3, the generated v4 will also lack it — matching the committed v4. Verify:

```bash
cd /Users/waltmayf/Documents/repos/edge-digital-ops-workshop
sed 's/%d/%.3f/g; s/3\.0\.0/4.0.0/g; s/telemetry-v3/telemetry-v4/g' job-scripts/telemetry-v3.sh > /tmp/v4-regen.sh
diff <(grep -v '^#' /tmp/v4-regen.sh) <(grep -v '^#' job-scripts/telemetry-v4.sh) && echo "v4 regen matches committed (modulo comments)"
```
Expected: `v4 regen matches committed (modulo comments)`. If the NOTE comment differs, that's fine (comments excluded); if any non-comment line differs, reconcile so the doc's `sed` output equals the committed v4.

- [ ] **Step 7: Commit**

```bash
git add job-scripts/telemetry-v2.sh job-scripts/telemetry-v3.sh job-scripts/telemetry-v4.sh
git commit -m "refactor(job-scripts): stop hand-writing \$package shadow; IoT Jobs owns it now"
```

---

## Task 6: Wire `--destination-package-versions` into block-2-iot-job.md

**Files:**
- Modify: `workshop/02-control/block-2-iot-job.md:92-126` (console step 3 + CLI `create-job`)

**Interfaces:**
- Consumes: the published `4.0.0` catalog version (Task 4).

- [ ] **Step 1: Add `--destination-package-versions` to the CLI create-job block**

In the `aws iot create-job` block (block-2:112-125), add the flag. The version ARN uses the placeholders:

```bash
--destination-package-versions \
    "arn:aws:iot:us-east-1:000000000000:package/ws-slot00-telemetry-agent/version/4.0.0" \
```

Place it after `--targets ...` and before `--job-executions-rollout-config`. Keep the existing `e2e:assert {"jsonPath": "jobId", "matches": "telemetry-v4-\\d+$", "jobSucceeds": true}`.

- [ ] **Step 2: Add the console-step instruction**

In console step 3 (block-2:92-104), add a bullet after the Job document bullet:

```markdown
- **Software package version (Deployment):** select `ws-slot00-telemetry-agent` version `4.0.0` — this associates the deployment with the catalog so IoT updates the device's `$package` shadow automatically on success.
```

- [ ] **Step 3: Add a short explanatory note after the CLI block**

```markdown
> **Note:** `--destination-package-versions` links this job to the published
> `telemetry-agent` catalog version. On `SUCCEEDED`, IoT Jobs writes the reserved
> `$package` shadow (`telemetry-agent.version: 4.0.0`) for you — the handler no
> longer writes it by hand. The handler still writes the app-level
> `device-config.reported.config_version` shadow, which package deployment does
> not manage.
```

- [ ] **Step 4: Verify placeholders (no real slot/account leaked)**

Run:
```bash
cd /Users/waltmayf/Documents/repos/edge-digital-ops-workshop
grep -nE "ws-slot0[1-9]|arn:aws:iot:[a-z0-9-]+:[0-9]{12}" workshop/02-control/block-2-iot-job.md | grep -v "000000000000" || echo "placeholders clean"
```
Expected: `placeholders clean`.

- [ ] **Step 5: Commit**

```bash
git add workshop/02-control/block-2-iot-job.md
git commit -m "docs(control): deploy telemetry-agent via package version (destination-package-versions)"
```

---

## Task 7: De-pin versions and reword block-4-fleet-management.md

**Files:**
- Modify: `workshop/02-control/block-4-fleet-management.md:11-36`

**Interfaces:**
- Consumes: nothing (doc-only).

- [ ] **Step 1: Fix the stale console link (`2.0.0` → `*`)**

Line 24 console deep-link: change `config_version%3A2.0.0` to `config_version%3A*` so it matches the CLI block's `:*` (the original 0-results bug).

- [ ] **Step 2: De-pin the step-2 heading prose**

Line 22: `**2. Run a Fleet Indexing query to confirm all devices report `2.0.0`:**` → `**2. Run a Fleet Indexing query to confirm all devices report a `config_version`:**`

- [ ] **Step 3: Reword step 1 to reflect the real, published catalog + package deployment**

Replace lines 11-12:

```markdown
- Observe the pre-registered package `ws-slot00-telemetry-agent` with published versions `1.0.0`–`4.0.0` (created by the platform/participant stacks — no manual registration needed)
- Because the Session-2 job deployed version `4.0.0` with `--destination-package-versions`, IoT Jobs updated each device's reserved `$package` shadow to `telemetry-agent.version: 4.0.0` automatically on success — the catalog is the source of truth for what each device runs
```

- [ ] **Step 4: Verify placeholders + no remaining stale pins**

Run:
```bash
cd /Users/waltmayf/Documents/repos/edge-digital-ops-workshop
grep -n "config_version%3A2.0.0\|report .2.0.0.\|version: 2.0.0" workshop/02-control/block-4-fleet-management.md || echo "no stale 2.0.0 pins"
```
Expected: `no stale 2.0.0 pins`.

- [ ] **Step 5: Commit**

```bash
git add workshop/02-control/block-4-fleet-management.md
git commit -m "docs(control): de-pin config_version queries; reflect published package catalog"
```

---

## Task 8: Prose sweep — reconcile "handler writes `$package`" claims

**Files:**
- Modify (as needed): `README.md`, `workshop/reference/repo-structure.md`, `workshop/02-control/index.md`

**Interfaces:**
- Consumes: nothing (doc-only).

- [ ] **Step 1: Find stale claims**

Run:
```bash
cd /Users/waltmayf/Documents/repos/edge-digital-ops-workshop
grep -rn "updates .*shadow\|\$package\|updates the shadow\|version: 2.0.0\|reports .*version" README.md workshop/reference/repo-structure.md workshop/02-control/index.md
```
Expected: a short list. The known hit is `README.md:146` (`telemetry-v2.sh # Updates telemetry to 1 Hz, adds net metrics, updates shadow`).

- [ ] **Step 2: Reconcile each hit**

For any prose asserting the handler updates the `$package`/software-package shadow, adjust to reflect that the handler writes `device-config` and IoT Jobs writes `$package` via the package deployment. Example for README.md:146:

```markdown
  telemetry-v2.sh         # Updates telemetry to 1 Hz, adds net metrics, updates device-config shadow
```

Leave references that are already accurate (e.g. generic "updates shadow" that clearly means device-config) unchanged; only fix ones that specifically attribute the `$package`/package-version write to the script.

- [ ] **Step 3: mkdocs strict build (if mkdocs available)**

Run:
```bash
cd /Users/waltmayf/Documents/repos/edge-digital-ops-workshop
command -v mkdocs >/dev/null && mkdocs build --strict 2>&1 | tail -15 || echo "mkdocs not installed locally — CI (deploy-docs.yml) will gate"
```
Expected: build passes, or the "not installed" fallback (edits touched no snippet paths, so strict-build risk is low; CI validates).

- [ ] **Step 4: Commit**

```bash
git add README.md workshop/reference/repo-structure.md workshop/02-control/index.md
git commit -m "docs: clarify handler writes device-config; IoT Jobs writes \$package"
```

---

## Task 9: Live verification (laptop credentials — hand-off, not backgrounded)

**Files:** none (verification only).

This is the acceptance gate. It requires the platform + one slot deployed, and is a long-running live-AWS operation. Per CLAUDE.md, do NOT background this inside an agent turn — hand the user a monitor script if a deploy is kicked off.

- [ ] **Step 1: Deploy platform stack first (hard ordering)**

Run (user, laptop creds): the repo's platform deploy (e.g. `pnpm run sandbox ws-slotNN` deploys platform first if absent, per CLAUDE.md). Confirm:
```bash
aws iot get-package-configuration --query 'versionUpdateByJobsConfig.enabled' --output text
```
Expected: `True`.

- [ ] **Step 2: Confirm catalog versions are PUBLISHED**

```bash
aws iot list-package-versions --package-name ws-slotNN-telemetry-agent \
  --query 'packageVersionSummaries[].{v:versionName,s:status}' --output table
```
Expected: `4.0.0` (and the others) show `PUBLISHED`.

- [ ] **Step 3: Run the block-2 doc-runner against the slot**

```bash
cd /Users/waltmayf/Documents/repos/edge-digital-ops-workshop/e2e
pnpm test:doc-runner -- workshop/02-control/block-2-iot-job.md --deployment-id ws-slotNN
```
Expected: all asserts pass; the job reaches `SUCCEEDED`.

- [ ] **Step 4: Confirm IoT (not the handler) wrote `$package`**

```bash
aws iot search-index --index-name AWS_Things \
  --query-string 'attributes.deploymentId:ws-slotNN' \
| jq -r '.things[] | "\(.thingName)  config=\(.shadow|fromjson|.name["device-config"].reported.config_version)  pkg=\(.shadow|fromjson|.name["$package"].reported["telemetry-agent"].version)"'
```
Expected: `config=4.0.0` (handler) and `pkg=4.0.0` (IoT Jobs) for all devices.

- [ ] **Step 5: Run the block-4 doc-runner (drift exercise still works)**

```bash
cd /Users/waltmayf/Documents/repos/edge-digital-ops-workshop/e2e
pnpm test:doc-runner -- workshop/02-control/block-4-fleet-management.md --deployment-id ws-slotNN
```
Expected: all asserts pass; the drift-detection step still finds the drifted device (proves `device-config.config_version` is still handler-owned).

- [ ] **Step 6: Open PR**

```bash
cd /Users/waltmayf/Documents/repos/edge-digital-ops-workshop
git push -u origin feat/package-deployments
gh pr create --title "feat(iot): telemetry-agent updates via package deployment" --body "$(cat <<'EOF'
Converts the telemetry-agent update flow from custom IoT Jobs to real Software Package deployments. Catalog is the source of truth; IoT Jobs auto-updates the reserved \$package shadow on success. See docs/superpowers/specs/2026-08-05-package-deployments-design.md.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Platform stack role + config → Tasks 1, 2 ✓
- Participant version attributes + publish → Task 4 ✓
- Publish mechanism (open item a) → resolved: no CFN status prop, use UpdatePackageVersion custom resource (Task 4) ✓
- Catalog version set (open item b) → resolved: 1.0.0–4.0.0, only 4.0.0 deployed by a doc (Task 4, Global Constraints) ✓
- Job scripts drop `$package` → Task 5 (all three, incl. committed v4 + sed consistency) ✓
- block-2 `--destination-package-versions` → Task 6 ✓
- block-4 de-pin + reword → Task 7 ✓
- Prose sweep → Task 8 ✓
- Deploy ordering (platform first) → Global Constraints + Task 9 Step 1 ✓
- Live verification (all 5 spec checks) → Task 9 ✓

**Placeholder scan:** Task 3 is a genuine discovery spike (build-command unknown until inspected), not a hidden TBD — it produces the concrete command the other tasks reuse. No "add error handling"/"TODO"/"similar to Task N" placeholders.

**Type consistency:** `iotJobsShadowUpdateRole` (Task 1) → consumed by name in Task 2 ✓. `softwarePackage` / `CfnSoftwarePackageVersion` / `telemetryAgentVersions` consistent within Task 4 ✓. Version `4.0.0` ARN consistent across Task 4 (publish), Task 6 (destination), Task 9 (verify) ✓.
