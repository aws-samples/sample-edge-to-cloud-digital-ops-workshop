#!/usr/bin/env tsx
/**
 * doc-runner-cli.ts — Standalone CLI for running annotated bash blocks from one
 * or more workshop .md files, without the full runner.ts deploy/teardown suite.
 *
 * Usage:
 *   pnpm run test:doc-runner -- workshop/02-control/block-2-iot-job.md
 *   pnpm run test:doc-runner -- workshop/02-control/block-2-iot-job.md workshop/03-state/block-2-shadow-job.md
 *   pnpm run test:doc-runner -- workshop/02-control --deployment-id ws-slot00
 *   pnpm run test:doc-runner -- workshop  # every .md file under the whole tree
 *
 * A directory argument is expanded to every .md file found under it (recursively).
 * Multiple file/directory arguments may be mixed in a single invocation.
 *
 * By default, any block annotated <!-- e2e:platform-teardown --> (i.e. one that
 * tears down the shared platform stack: VPCs, EKS, MSK) is refused — pass
 * --delete-platform-stack to opt in.
 *
 * Personas (--persona / E2E_PERSONA):
 *   (unset)      run every annotated block regardless of persona tag (default)
 *   admin        run admin + untagged blocks as a cluster-admin principal; the
 *                calling role is granted cluster-scoped EKS/Cognito access first
 *   participant  run participant + untagged blocks the way a real attendee does:
 *                the runner assumes WorkshopParticipantRole-<slot> via STS and
 *                runs both `aws` CLI and `kubectl`/`helm` as that role (its
 *                full scoped identity). No cluster-admin grant is performed.
 *
 * Pass --report-out <path> (or set E2E_REPORT_OUT) to additionally write the
 * run summary to a markdown file. If <path> is a directory (or the flag/env
 * var is set with no live value, defaulting to e2e/reports/), the file is
 * named YYYY-MM-DD-<deployment-id>.md. stdout output is unchanged either way.
 *
 * Environment variables:
 *   WORKSHOP_TEST_SLOT          deployment ID (default: ws-e2e-test)
 *   AWS_REGION                  AWS region (default: us-east-1)
 *   E2E_DELETE_PLATFORM_STACK   "true" to also allow platform-teardown blocks (default: false)
 *   E2E_PERSONA                 "admin" | "participant" (default: unset — all blocks)
 *   E2E_SKIP_EKS_GRANT          "true" to skip the best-effort EKS/Cognito access
 *                               grant in the admin persona (default: false — see below)
 *   E2E_REPORT_OUT              path to write the run report to (see --report-out above)
 */

import { join, relative } from "node:path";
import { readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { STSClient, GetCallerIdentityCommand, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { runDocBlocks, type BlockResult, type Persona } from "./doc-runner.js";
import { resolveReportPath, renderReport } from "./report.js";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const USAGE = [
  "Usage: doc-runner-cli.ts <path-to-workshop-md-file-or-dir> [<path> ...] [options]",
  "",
  "Options:",
  "  --deployment-id <id>      Deployment slot to test against (default: $WORKSHOP_TEST_SLOT or ws-e2e-test)",
  "  --delete-platform-stack   Also allow blocks annotated <!-- e2e:platform-teardown -->",
  "  --persona <admin|participant>",
  "                            Run under a specific persona's identity (env: E2E_PERSONA).",
  "                            Default: unset — run every annotated block regardless of persona tag.",
  "  --report-out <path>       Write the run summary to a markdown file, in addition to stdout.",
  "                            If <path> is a directory (default: e2e/reports/), the file is named",
  "                            YYYY-MM-DD-<deployment-id>.md. (env: E2E_REPORT_OUT)",
  "  --help, -h                Show this help",
].join("\n");

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

// Flags that take a value — the token after them is the value, not a path arg.
const VALUE_FLAGS = new Set(["--deployment-id", "--persona", "--report-out"]);
const pathArgs = args.filter(
  (a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1])
);
if (pathArgs.length === 0) {
  console.error(USAGE);
  process.exit(1);
}

// Directories that never contain workshop source docs — skip them when walking
// a tree so vendored/build artefacts (e.g. a local `.venv` of MkDocs deps, or
// the built site) don't get scanned for e2e:assert blocks.
const SKIP_DIRS = new Set([".venv", "node_modules", "site", ".git"]);

function collectMdFiles(path: string): string[] {
  const stat = statSync(path);
  if (stat.isFile()) {
    return path.endsWith(".md") ? [path] : [];
  }
  const out: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...collectMdFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

const mdPaths = [
  ...new Set(
    pathArgs
      .map((a) => (a.startsWith("/") ? a : join(REPO_ROOT, a)))
      .flatMap(collectMdFiles)
  ),
].sort();

if (mdPaths.length === 0) {
  console.error("No .md files found for the given path(s).");
  process.exit(1);
}

const deploymentIdIdx = args.indexOf("--deployment-id");
const DEPLOYMENT_ID =
  deploymentIdIdx !== -1 ? args[deploymentIdIdx + 1] : process.env.WORKSHOP_TEST_SLOT ?? "ws-e2e-test";
const REGION = process.env.AWS_REGION ?? "us-east-1";
// Platform teardown (deleting the shared VPCs/EKS/MSK) must be explicitly opted
// into — never run as a side effect of a routine doc-runner pass.
const ALLOW_PLATFORM_TEARDOWN =
  process.env.E2E_DELETE_PLATFORM_STACK === "true" || args.includes("--delete-platform-stack");

const personaIdx = args.indexOf("--persona");
const PERSONA_RAW = personaIdx !== -1 ? args[personaIdx + 1] : process.env.E2E_PERSONA;
if (PERSONA_RAW !== undefined && PERSONA_RAW !== "admin" && PERSONA_RAW !== "participant") {
  console.error(`Invalid --persona "${PERSONA_RAW}" — expected "admin" or "participant".`);
  process.exit(1);
}
const PERSONA = PERSONA_RAW as Persona | undefined;

const reportOutIdx = args.indexOf("--report-out");
const REPORT_OUT_RAW =
  reportOutIdx !== -1 ? args[reportOutIdx + 1] : process.env.E2E_REPORT_OUT;

const ssm = new SSMClient({ region: REGION });
const sts = new STSClient({ region: REGION });

const callerIdentity = await sts.send(new GetCallerIdentityCommand({}));
const ACCOUNT_ID = callerIdentity.Account!;

// Persona setup — two mutually exclusive credential paths (participant
// assumption happens later, after SSM config is resolved with ambient creds,
// since the participant role can't read SSM):
//
//   admin (or unset) — the calling principal acts as cluster-admin. Best-effort
//     grant it the cluster-scoped EKS access (and Cognito admin write) that the
//     cluster-scoped installs (cert-manager, operators, default StorageClass)
//     and create-workshop-user need. A CI/facilitator role that didn't create
//     the cluster is otherwise invisible to the cluster's RBAC and every kubectl
//     block fails "the server has asked for the client to provide credentials".
//     grant-ci-access.sh is idempotent; the grant is never fatal (a grant
//     problem shouldn't masquerade as a doc defect).
//
//   participant — handled after SSM resolution below: ASSUME
//     WorkshopParticipantRole-<slot> so the run exercises exactly the
//     scoped access a real attendee has for both `aws` CLI and
//     `kubectl`/`helm`. No cluster-admin grant.
if (PERSONA !== "participant" && process.env.E2E_SKIP_EKS_GRANT !== "true") {
  // admin (or unset default): grant the calling role cluster access.
  // The caller is an assumed-role session ARN
  // (arn:aws:sts::ACCT:assumed-role/<RoleName>/<session>); EKS access entries key
  // on the underlying IAM role ARN (arn:aws:iam::ACCT:role/<RoleName>). Convert.
  const callerArn = callerIdentity.Arn ?? "";
  const assumedRole = callerArn.match(/^arn:aws:sts::(\d+):assumed-role\/([^/]+)\//);
  const roleArn = assumedRole
    ? `arn:aws:iam::${assumedRole[1]}:role/${assumedRole[2]}`
    : callerArn.includes(":role/")
    ? callerArn
    : "";
  const roleName = roleArn ? roleArn.split("/").pop()! : "";
  // Participant roles are already namespace-scoped by CDK and lack the IAM perms
  // to grant themselves anything — don't attempt (and don't warn).
  if (roleArn && !roleName.startsWith("WorkshopParticipantRole")) {
    try {
      execFileSync(
        join(REPO_ROOT, "scripts/grant-ci-access.sh"),
        ["--role-arn", roleArn],
        { stdio: "pipe", env: { ...process.env, AWS_REGION: REGION } }
      );
      console.log(`  EKS/Cognito access     : granted to ${roleName}`);
    } catch (err) {
      // Non-fatal: the role may already have access, or lack eks:CreateAccessEntry.
      const msg = err instanceof Error && "stderr" in err ? String((err as { stderr?: Buffer }).stderr ?? err.message) : String(err);
      console.warn(`  EKS/Cognito access     : grant skipped (${msg.trim().split("\n").pop()})`);
      console.warn("    Set E2E_SKIP_EKS_GRANT=true to silence, or grant manually:");
      console.warn(`    scripts/grant-ci-access.sh --role-arn ${roleArn}`);
    }
  }
}

// Resolve deployment config from SSM (published by the CDK stacks themselves)
// rather than deriving it by naming convention — this fails fast with a clear
// error if the deployment slot hasn't been deployed yet, mirroring the check
// in runner.ts (see "Deployment config resolvable via SSM").
const ssmNames = ["deployment-id", "shared-bucket-name", "graphql-endpoint"].map(
  (suffix) => `/workshop/${DEPLOYMENT_ID}/${suffix}`
);
let ssmValues: (string | undefined)[];
try {
  ssmValues = await Promise.all(
    ssmNames.map((name) => ssm.send(new GetParameterCommand({ Name: name })).then((r) => r.Parameter?.Value))
  );
} catch (err) {
  console.error(`Failed to resolve SSM parameters for deployment slot "${DEPLOYMENT_ID}":`);
  console.error(`  ${err instanceof Error ? err.name : String(err)}`);
  console.error(`Has the slot been deployed? Try: pnpm run sandbox:all ${DEPLOYMENT_ID}`);
  process.exit(1);
}
const missing = ssmNames.filter((_, i) => !ssmValues[i]);
if (missing.length > 0) {
  console.error(`Deployment slot "${DEPLOYMENT_ID}" is missing SSM parameters: ${missing.join(", ")}`);
  console.error(`Has the slot been deployed? Try: pnpm run sandbox:all ${DEPLOYMENT_ID}`);
  process.exit(1);
}
const [, SHARED_BUCKET, GRAPHQL_ENDPOINT] = ssmValues as string[];

// participant persona: model the real attendee's identity — Model 2.
//
// WorkshopParticipantRole-<slot> is the participant's FULL identity, not an
// EKS-only assume-role: a real attendee assumes the role once and runs every
// non-admin step (aws CLI *and* kubectl/helm) as that role. So we AssumeRole
// via STS and inject the returned creds into process.env — every block
// inherits process.env, so both `aws` and `kubectl`/`helm` (via the
// `aws eks get-token` exec plugin) run as the participant role. We build a
// dedicated kubeconfig (rather than relying on ambient update-kubeconfig) so
// KUBECONFIG can't be clobbered by the doc's own cluster-admin
// `update-kubeconfig` step, which is tagged persona:admin and skipped here.
//
// The kubeconfig is built WITHOUT --role-arn: the injected process.env creds
// already ARE the participant role, so the exec plugin's `aws eks get-token`
// mints a token for that identity directly. Passing --role-arn would make the
// plugin call sts:AssumeRole on the participant role FROM the participant role
// (self-assume) — which the role can't (and a real attendee never would) do,
// failing every kubectl block with AccessDenied on sts:AssumeRole.
//
// This assumption happens AFTER SSM resolution above, which must run on
// ambient creds — the participant role can't read /workshop/<slot>/* params.
let personaLabel = "any (all blocks)";
if (PERSONA === "participant") {
  const participantRoleArn = `arn:aws:iam::${ACCOUNT_ID}:role/WorkshopParticipantRole-${DEPLOYMENT_ID}`;
  const kubeconfigPath = join(tmpdir(), `e2e-participant-kubeconfig-${DEPLOYMENT_ID}`);
  try {
    const assumed = await sts.send(
      new AssumeRoleCommand({
        RoleArn: participantRoleArn,
        RoleSessionName: `doc-runner-participant-${DEPLOYMENT_ID}`,
      })
    );
    const creds = assumed.Credentials;
    if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
      throw new Error("AssumeRole returned no usable credentials");
    }
    process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
    process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
    process.env.AWS_SESSION_TOKEN = creds.SessionToken;

    execFileSync(
      "aws",
      [
        "eks", "update-kubeconfig",
        "--name", "workshop-eks",
        "--region", REGION,
        // No --role-arn: process.env already holds the assumed participant-role
        // creds, so the exec plugin gets a token AS the role. Adding --role-arn
        // would trigger a self-assume (role assuming itself) → AccessDenied.
        "--kubeconfig", kubeconfigPath,
      ],
      { stdio: "pipe", env: { ...process.env } }
    );
    // Every block inherits process.env, so kubectl/helm/aws-eks-get-token in the
    // blocks read this KUBECONFIG and assume the participant role for tokens.
    process.env.KUBECONFIG = kubeconfigPath;
    personaLabel = `participant (aws+kubectl→${participantRoleArn.split("/").pop()})`;
  } catch (err) {
    const msg = err instanceof Error && "stderr" in err ? String((err as { stderr?: Buffer }).stderr ?? err.message) : String(err);
    console.error(`Persona participant — FAILED to assume/configure ${participantRoleArn}`);
    console.error(`  ${msg.trim().split("\n").pop()}`);
    console.error("  Ensure the slot is deployed and your identity has sts:AssumeRole on that role.");
    process.exit(1);
  }
} else if (PERSONA === "admin") {
  personaLabel = "admin (cluster-scoped)";
}

console.log(`  Persona                : ${personaLabel}`);
console.log(`  Doc files              : ${mdPaths.length}`);
console.log(`  Deployment ID          : ${DEPLOYMENT_ID}`);
console.log(`  Region                 : ${REGION}`);
console.log(`  Account ID             : ${ACCOUNT_ID}`);
console.log(`  Shared bucket          : ${SHARED_BUCKET}`);
console.log(`  GraphQL URL            : ${GRAPHQL_ENDPOINT}`);
console.log(`  Allow platform teardown: ${ALLOW_PLATFORM_TEARDOWN}`);
console.log("");

interface FileSummary {
  file: string;
  results: BlockResult[];
}

const fileSummaries: FileSummary[] = [];

for (const mdPath of mdPaths) {
  const results: BlockResult[] = [];
  console.log(`── ${relative(REPO_ROOT, mdPath)} `.padEnd(70, "─"));

  try {
    await runDocBlocks(
      mdPath,
      { DEPLOYMENT_ID, ACCOUNT_ID, SHARED_BUCKET, REGION, GRAPHQL_ENDPOINT },
      REPO_ROOT,
      (r) => {
        results.push(r);
        if (r.passed) {
          console.log(`  ✓  block ${r.blockIndex + 1}  [${r.durationMs}ms]`);
        } else {
          console.error(`  ✗  block ${r.blockIndex + 1}  [${r.durationMs}ms]`);
          console.error(`       ${r.error}`);
        }
      },
      { allowPlatformTeardown: ALLOW_PLATFORM_TEARDOWN, persona: PERSONA }
    );
  } catch (err) {
    console.error(`  ✗  ${err instanceof Error ? err.message : String(err)}`);
    results.push({
      file: mdPath,
      blockIndex: -1,
      script: "",
      stdout: "",
      stderr: "",
      passed: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: 0,
    });
  }

  if (results.length === 0) {
    console.log("  No annotated (e2e:assert) blocks found in this file.");
  }

  fileSummaries.push({ file: mdPath, results });
  console.log("");
}

console.log("═".repeat(70));
console.log("  Per-file summary");
console.log("═".repeat(70));

let totalPassed = 0;
let totalBlocks = 0;
for (const { file, results } of fileSummaries) {
  const failed = results.filter((r) => !r.passed);
  totalPassed += results.length - failed.length;
  totalBlocks += results.length;
  const status = results.length === 0 ? "(no annotated blocks)" : `${results.length - failed.length}/${results.length} passed`;
  console.log(`  ${failed.length > 0 ? "✗" : "✓"}  ${relative(REPO_ROOT, file)}  —  ${status}`);
}

console.log("");
console.log(`  ${totalPassed}/${totalBlocks} blocks passed across ${mdPaths.length} file(s)`);

if (REPORT_OUT_RAW !== undefined) {
  const runDate = new Date().toISOString().slice(0, 10);
  const reportPath = resolveReportPath(REPORT_OUT_RAW || "e2e/reports/", REPO_ROOT, DEPLOYMENT_ID, runDate);
  const report = renderReport(
    fileSummaries.map(({ file, results }) => ({ file: relative(REPO_ROOT, file), results })),
    { deploymentId: DEPLOYMENT_ID, region: REGION, accountId: ACCOUNT_ID, runDate }
  );

  mkdirSync(join(reportPath, ".."), { recursive: true });
  writeFileSync(reportPath, report);
  console.log(`  Report written to      : ${relative(REPO_ROOT, reportPath)}`);
}

const anyFailed = fileSummaries.some(({ results }) => results.some((r) => !r.passed));
process.exit(anyFailed ? 1 : 0);
