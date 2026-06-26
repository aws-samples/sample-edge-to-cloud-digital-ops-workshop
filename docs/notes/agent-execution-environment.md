# Agent Execution Environment — Capability Report

> Generated in response to issue #13 / @waltmayf's live chat inquiry.

## TL;DR

| Capability | Available? | Notes |
|---|---|---|
| TypeScript type-check (`tsc`) | ❌ No | No Node.js runtime installed |
| E2E tests (`tsx runner.ts`) | ❌ No | No Node.js / tsx runtime |
| Playwright | ❌ No | `playwright` binary not found; Node.js absent |
| `aws sts get-caller-identity` | ❌ No | AWS CLI not installed |
| Python 3 | ✅ Yes | Python 3.12.13 at `/usr/local/bin/python3` |
| Git | ✅ Yes | Can clone, branch, commit, push |
| `gh` CLI | ✅ Yes | Authenticated; can open PRs |

---

## Detailed Findings

### 1. Type Checks

The project has three TypeScript configs:

| Location | Config |
|---|---|
| `tsconfig.json` (root) | Amplify backend, targets `amplify/**/*.ts` |
| `frontend/tsconfig.json` | Next.js app, `strict: true`, `noEmit: true` |
| `e2e/tsconfig.json` | E2E runner, targets `./**/*.ts` |

Running `tsc --noEmit` (type-check without emitting files) requires the `tsc` binary from the `typescript` npm package.  
**Result:** `tsc: not found` — Node.js is **not installed** in this execution environment, so `tsc`, `npm`, `npx`, `pnpm`, and `tsx` are all unavailable.

### 2. E2E Tests

The e2e suite lives in `e2e/` and is launched via:
```
tsx runner.ts
```
It uses `@playwright/test` and `playwright` as dev dependencies (see `e2e/package.json`), plus AWS SDK v3 clients to drive real infrastructure (EKS, MSK, IoT, Athena, etc.).

**Result:** Cannot run. Both `tsx` and `playwright` require Node.js, which is absent.

### 3. Playwright

`playwright` is listed as a devDependency in `e2e/package.json` (`^1.60.0`), but:
- `which playwright` → not found
- `npx playwright` → `npx` not found (no Node.js)

Even if Node.js were installed and `pnpm install` were run, Playwright also requires browser binaries (Chromium/Firefox/WebKit) installed via `playwright install`. The current environment (Debian 13 / aarch64) may not have the necessary system libraries for headless browsers, and the agent's network/sandbox constraints would likely block browser launches.

### 4. `aws sts get-caller-identity`

**Result:** `aws: not found` — the AWS CLI is **not installed**.

However, the environment _does_ have AWS context available via environment variables:

```
AWS_DEFAULT_REGION=us-east-1
AWS_REGION=us-east-1
AWS_EXECUTION_ENV=AWS_BedrockAgentCore_Runtime
```

The agent runtime is identified as **AWS Bedrock AgentCore** running in `us-east-1`, account `796988593450` (visible in the `AGENTCORE_RUNTIME_URL` ARN).  
Credentials are likely injected via the container's IAM role rather than the CLI credential chain, which is why the CLI itself isn't needed (or installed).

### 5. What _Is_ Available

| Tool | Version / Path |
|---|---|
| Python 3 | 3.12.13 @ `/usr/local/bin/python3` |
| pip3 | `/usr/local/bin/pip3` |
| git | Available (used to push this commit) |
| gh CLI | Authenticated to GitHub |
| Shell (sh) | `/bin/sh` |
| curl | Available |
| OS | Debian GNU/Linux 13 (trixie), kernel `6.1.161` (Amazon Linux 2023 kernel), aarch64 |

Python-based tooling (e.g. `mkdocs`, `boto3`) _could_ be installed via `pip` if needed.

---

## Recommendations

If CI-level type-checks and e2e tests are desired in agent-initiated PRs, consider:

1. **GitHub Actions** — add a workflow (`.github/workflows/typecheck.yml`) that installs Node.js 20, runs `pnpm install`, and executes `tsc --noEmit` in `frontend/` and `e2e/`. This would run automatically on every PR.
2. **Separate test environment** — the e2e suite already requires live AWS infrastructure (EKS, MSK, etc.), so it's inherently unsuitable for an isolated agent sandbox. A dedicated CI runner with AWS credentials and the full stack deployed is the right venue.
3. **AWS CLI in agent image** — if `aws sts get-caller-identity` output is needed by the agent for decision-making, installing the AWS CLI (or using `boto3` via Python) in the agent container image would address this.

