# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A hands-on AWS workshop (7 sessions × 4 hrs) teaching real-time edge-to-cloud IoT data pipelines. Participants instrument simulated edge devices, route MQTT telemetry through a cloud pipeline, and compare data-store freshness/scaling tradeoffs side by side. The repo contains **both** the infrastructure participants deploy **and** the MkDocs-based workshop instructions that drive them through it. `README.md` and `workshop/reference/` (architecture, decisions, gotchas, repo-structure) have the deepest detail.

## GitHub Issue Relationships

When one issue is blocked by (or blocks) another, **always record it with GitHub's native issue-relationships feature** — do not rely on a prose "Blocked by #NN" line or a comment alone. The native relationship drives the "Blocked by / Blocking" panel on the issue and the `issue_dependencies_summary` in the API; prose does not. A prose note or comment explaining *why* is fine as a supplement, but the structured relationship must always be set.

`gh` has no first-class subcommand for this yet, so use the REST dependencies API. To mark issue `<blocked>` as **blocked by** issue `<blocker>`:

```bash
# Look up the blocker's numeric database ID, then add the dependency.
BLOCKER_ID=$(gh api graphql -f query='query { repository(owner:"OWNER",name:"REPO"){ issue(number:BLOCKER){ databaseId } } }' -q '.data.repository.issue.databaseId')
gh api --method POST \
  -H "Accept: application/vnd.github+json" \
  "/repos/OWNER/REPO/issues/<blocked>/dependencies/blocked_by" \
  -F issue_id="$BLOCKER_ID"
```

The response's `issue_dependencies_summary` (`{"blocked_by":1,...}`) confirms it took. The inverse `blocking` relationship is created automatically on the other issue — set only one side. To remove, use `--method DELETE` on the same path with the blocker's ID.

## Common Commands

Root uses **pnpm** (see Package Manager rule below). `frontend/`, `hmi/`, and `e2e/` are separate workspaces with their own `package.json`.

```bash
# Deploy — shared platform stack (VPCs, EKS, MSK, Flink) + per-slot Amplify sandbox
pnpm run sandbox ws-slot00                       # single slot (deploys platform first if absent)
pnpm run sandbox:all ws-slot00 ws-slot01 ...     # platform once, then fan out slots
pnpm run sandbox:delete-all                      # teardown all slots
scripts/teardown.sh ws-slot00                    # per-slot cleanup (preserves shared VPC/EKS)

# Verify a deployment
pnpm test                                        # scripts/smoke-test.mjs (needs WORKSHOP_TEST_SLOT)
WORKSHOP_TEST_SLOT=ws-slot00 node scripts/smoke-test.mjs

# End-to-end suite (deploys, exercises every session via AWS SDK, tears down)
pnpm run e2e                                      # full run
pnpm run e2e:no-deploy                            # against already-running stacks
pnpm run e2e:walkthrough                          # doc-runner walkthrough, no deploy/teardown
cd e2e && pnpm test -- --session observe          # run one phase only
cd e2e && pnpm test -- --deployment-id ws-slot01  # target a specific slot

# Admin helpers
scripts/create-workshop-user.sh ws-slot00 participant@example.com
scripts/deploy-device-client.sh ws-slot00        # push IoT Device Client binary via SSM

# Docs (MkDocs Material) — served from workshop/, base_path resolves to repo root
mkdocs serve                                      # live-reload preview at :8000
mkdocs build --strict                             # CI gate — broken snippet tag = failure
# Do NOT run `mkdocs gh-deploy` locally; the deploy-docs.yml workflow publishes on push to main

# Front-end apps (Next.js)
cd frontend && pnpm dev                            # cloud UI (fleet view + freshness panel)
cd hmi && pnpm dev                                 # edge HMI (site view, runs on EKS via Helm)
```

## Architecture

**Two deployment tiers, built with Amplify Gen 2 wrapping raw CDK stacks:**

- `amplify/backend.ts` — entry point. Requires `WORKSHOP_DEPLOYMENT_ID` (e.g. `ws-slot00`) + `CDK_DEFAULT_ACCOUNT/REGION` in env (set by `ampx sandbox` / `scripts/sandbox.sh`). Defines auth + data, then instantiates one `ParticipantStack` per slot.
- `amplify/custom/platform-stack.ts` (+ `platform-app.ts` standalone CDK app entry) — **shared, deployed once per account**: two VPCs (`workshop-edge` 10.0/16, `workshop-cloud` 10.1/16), EKS cluster, MSK cluster, Managed Flink app, shared S3. Stack name is `WorkshopPlatformStackV2` or `WorkshopPlatformStack` (V2 wins); sandbox scripts detect which exists.
- `amplify/custom/participant-stack.ts` — **per-slot, isolated**: 3× EC2 (IoT Device Client, fleet-provisioned by claim cert), IoT provisioning template + pre-provisioning Lambda, per-slot MSK topics, S3 telemetry landing, Athena workgroup, AppSync Events API, Secrets Manager claim cert. Uses `Vpc.fromLookup` (needs concrete account/region at synth — why backend.ts throws without them).
- `amplify/data/resource.ts` — AppSync GraphQL schema (Amplify Gen 2). `publishTelemetry` mutation + `onTelemetry` subscription with JS resolvers in the same dir. Cross-stack GraphQL URL is passed by CFN export name + SSM param (`/workshop/<id>/graphql-endpoint`) to avoid CDK cross-env-stack validation.

**Data pipeline (two paths from the same MQTT publish):**
1. Device MQTT → IoT Rules → **AppSync Events API** (SigV4 HTTP action, no Lambda hop) → browser WebSocket. ~10–80 ms live push, no database.
2. Device MQTT → IoT Rules → **S3 landing** → Redpanda Connect → **MSK** → **TimescaleDB** (continuous aggregate `pump_rate_10s`, queried on demand). Plus a **Hudi/Athena** static reference and Managed Flink → Iceberg sink (`flink-hudi-sink/`, Java/Maven).

The **data-freshness comparison panel** (frontend) is the centrepiece: same pump-rate metric via AppSync push vs. TimescaleDB CAGG vs. Hudi/Athena. AppSync Events acts as a *clock signal* — the browser fires a stateless HTTP query for the latest CAGG on each event rather than holding a `LISTEN/NOTIFY` connection.

**Edge stack (EKS + Helm, `helm/edge-stack/`):** TimescaleDB (CloudNativePG), Redpanda + Connect, RisingWave, MinIO, and the HMI. TimescaleDB is the system of record at the edge; MSK/Redpanda buffer is expendable and backfilled from edge on reconnect. `job-scripts/` are IoT Job handler scripts pushed to devices (telemetry versions, K3s bootstrap, shadow timers).

**Testing:** `e2e/runner.ts` is a `tsx` script (not a test framework) — phases map to workshop sessions (`platform|observe|control|state|analytics|edge|hmi|teardown`). `e2e/doc-runner.ts` extracts bash blocks from `workshop/*.md` annotated with `<!-- e2e:assert {...} -->` comments and executes them, so the published docs are themselves verified. Substitutions (`ws-slot00`, `000000000000`) are applied before running.

## Long Runnting Tasks

Keep a .md file up to date in `./tmp/progress` with the current state of acomplishing any task that takes you more than 10 minutes to complete. I'll use that to understand the current state of the operation.

## Package Manager

Always use `pnpm` instead of `npm` for package installation — `pnpm install`, `pnpm add`, etc. `npx` is still fine for one-off CLI tool invocations like `npx ampx sandbox`.

## Workshop Docs — Embedding Code Snippets from the Repo

Code blocks in workshop docs should be pulled live from source files using MkDocs Snippets, not duplicated inline. This ensures docs and code can never silently diverge — a broken tag fails `mkdocs build --strict`.

### 1. Tag the source file

Add `--8<-- [start:name]` and `--8<-- [end:name]` markers in the source file using the file's native comment syntax:

**Bash / shell:**
```bash
# --8<-- [start:my-section]
...code...
# --8<-- [end:my-section]
```

**TypeScript:**
```typescript
// --8<-- [start:my-section]
...code...
// --8<-- [end:my-section]
```

Tag names must be unique within a file. Keep them short and kebab-case.

### 2. Embed in the doc

Use a `??? example` collapsible admonition with a GitHub button above the code block. The `--8<--` directive goes inside the fenced code block:

~~~markdown
??? example "View source — description of what this shows"
    [:simple-github: Open in GitHub](https://github.com/energy-digital-operations/edge-digital-operations-workshop/blob/main/path/to/file){ .md-button target=_blank }

    ```typescript
    --8<-- "path/to/file.ts:my-section"
    ```
~~~

The path in `--8<-- "..."` is resolved relative to `base_path: [workshop, .]` in `mkdocs.yml` — meaning paths are relative to the **repo root**, not the `workshop/` docs dir.

### 3. Rules

- **Never hardcode GitHub line-number URLs** (e.g. `#L356`) — line numbers drift as the file changes. Use snippet tags instead, or link to the file without an anchor.
- **Never duplicate code** from `job-scripts/`, `amplify/`, or `frontend/` inline in docs. Always use `--8<-- "..."`.
- The `check_paths: true` setting in `mkdocs.yml` means a missing snippet path is a build error — this is intentional. If you rename or delete a tagged file, update the docs at the same time.

## Progress Files

Keep a running progress log at `./tmp/progress/YYYY-MM-DD-PROGRESS.md` (one file per day, date-prefixed). Update it as work completes or blockers change. Do not write progress files anywhere else in the repo.

## Workshop Docs — Deployment ID and Account ID Substitution

All participant-specific values in workshop docs use two placeholder strings that the browser swaps client-side:

| Placeholder | Query param | Example value |
|---|---|---|
| `ws-slot00` | `?did=` | `ws-slot05` |
| `000000000000` | `?aid=` | `123456789012` |

The JS in `workshop/javascripts/deployment-id.js` replaces these strings in:
- Every `<code>` and `<pre>` element (text content)
- Every `<a href="...">` attribute — so console deep-links are also rewritten

Values persist in `sessionStorage` so participants don't need `?did=` on every URL — just the first page they land on.

**Rules for writing docs:**
- Always use `ws-slot00` and `000000000000` as the literal placeholder strings in code blocks **and** in `href` attributes of console links — never hardcode a real slot or account.
- Never write "replace `ws-slot00` with your slot number" in prose — the substitution makes that instruction confusing (it reads as "replace your already-correct slot with your slot"). Just use the placeholder and let the JS do the work.
- Prose outside `<code>`/`<pre>`/`<a href>` is **not** substituted — don't rely on substitution for prose.

## Workshop Docs — IoT Console Deep-Links

Console links for IoT Fleet Indexing searches must follow these rules or the search won't auto-trigger and may return 0 results:

1. **Always lead with a positive term** — queries that start with `NOT` fail silent validation in the console and require a manual click. Prefix any `NOT` query with a scoped positive filter, e.g. `attributes.deploymentId:ws-slot00 AND NOT (...)`.

2. **Match the CLI query exactly** — if the AWS CLI equivalent uses `attributes.deploymentId:ws-slot00`, the console URL must too. A missing filter causes 0 results even when the CLI works fine.

3. **Encode the colon as `%3A`, not as a literal `:` followed by a space** — `field%3Avalue` is the correct form; `field: value` breaks field-comparison syntax.

4. **Never wrap the entire query in quotes** — `%22(...)%22` turns the expression into a phrase match, not a field comparison. Quotes are only valid around literal string values.

Example of a correct drift-detection URL:
```
https://us-east-1.console.aws.amazon.com/iot/home?region=us-east-1#/search?indexType=AWS_Things&search=attributes.deploymentId%3Aws-slot00%20AND%20NOT%20(shadow.name.device-config.desired.config_version%3Ashadow.name.device-config.reported.config_version)
```

## Local / Internal Notes (not committed)

The line below imports machine-local and Amazon-internal guidance from a gitignored file. It silently no-ops for anyone who clones the public repo without it.

@./CLAUDE.private.md

