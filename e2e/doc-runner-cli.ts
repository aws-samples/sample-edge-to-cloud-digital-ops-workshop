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
 * Environment variables:
 *   WORKSHOP_TEST_SLOT          deployment ID (default: ws-e2e-test)
 *   AWS_REGION                  AWS region (default: us-east-1)
 *   E2E_DELETE_PLATFORM_STACK   "true" to also allow platform-teardown blocks (default: false)
 */

import { join, relative } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { runDocBlocks, type BlockResult } from "./doc-runner.js";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const args = process.argv.slice(2);
const pathArgs = args.filter(
  (a, i) => !a.startsWith("--") && args[i - 1] !== "--deployment-id"
);
if (pathArgs.length === 0) {
  console.error("Usage: doc-runner-cli.ts <path-to-workshop-md-file-or-dir> [<path> ...] [--deployment-id <id>]");
  process.exit(1);
}

function collectMdFiles(path: string): string[] {
  const stat = statSync(path);
  if (stat.isFile()) {
    return path.endsWith(".md") ? [path] : [];
  }
  const out: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
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

const ssm = new SSMClient({ region: REGION });
const sts = new STSClient({ region: REGION });

const ACCOUNT_ID = (await sts.send(new GetCallerIdentityCommand({}))).Account!;

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
      { allowPlatformTeardown: ALLOW_PLATFORM_TEARDOWN }
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

const anyFailed = fileSummaries.some(({ results }) => results.some((r) => !r.passed));
process.exit(anyFailed ? 1 : 0);
