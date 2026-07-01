#!/usr/bin/env tsx
/**
 * doc-runner-cli.ts — Standalone CLI for running annotated bash blocks from a
 * single workshop .md file, without the full runner.ts deploy/teardown suite.
 *
 * Usage:
 *   pnpm run test:doc-runner -- workshop/02-control/block-2-iot-job.md
 *   pnpm run test:doc-runner -- workshop/03-state/block-2-shadow-job.md --deployment-id ws-slot00
 *
 * Environment variables (same names as runner.ts):
 *   WORKSHOP_TEST_SLOT   deployment ID (default: ws-e2e-test)
 *   AWS_REGION           AWS region (default: us-east-1)
 */

import { execSync } from "node:child_process";
import { join } from "node:path";
import { runDocBlocks, type BlockResult } from "./doc-runner.js";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const args = process.argv.slice(2);
const mdArg = args.find((a) => !a.startsWith("--"));
if (!mdArg) {
  console.error("Usage: doc-runner-cli.ts <path-to-workshop-md-file> [--deployment-id <id>]");
  process.exit(1);
}
const mdPath = mdArg.startsWith("/") ? mdArg : join(REPO_ROOT, mdArg);

const deploymentIdIdx = args.indexOf("--deployment-id");
const DEPLOYMENT_ID =
  deploymentIdIdx !== -1 ? args[deploymentIdIdx + 1] : process.env.WORKSHOP_TEST_SLOT ?? "ws-e2e-test";
const REGION = process.env.AWS_REGION ?? "us-east-1";
const ACCOUNT_ID = execSync("aws sts get-caller-identity --query Account --output text", {
  encoding: "utf8",
}).trim();
const SHARED_BUCKET = `workshop-platform-${ACCOUNT_ID}`;

console.log(`  Doc file       : ${mdPath}`);
console.log(`  Deployment ID  : ${DEPLOYMENT_ID}`);
console.log(`  Region         : ${REGION}`);
console.log(`  Account ID     : ${ACCOUNT_ID}`);
console.log("");

const results: BlockResult[] = [];

await runDocBlocks(
  mdPath,
  { DEPLOYMENT_ID, ACCOUNT_ID, SHARED_BUCKET, REGION },
  REPO_ROOT,
  (r) => {
    results.push(r);
    if (r.passed) {
      console.log(`  ✓  block ${r.blockIndex + 1}  [${r.durationMs}ms]`);
    } else {
      console.error(`  ✗  block ${r.blockIndex + 1}  [${r.durationMs}ms]`);
      console.error(`       ${r.error}`);
    }
  }
);

if (results.length === 0) {
  console.log("  No annotated (e2e:assert) blocks found in this file.");
}

const failed = results.filter((r) => !r.passed);
console.log("");
console.log(`  ${results.length - failed.length}/${results.length} blocks passed`);

process.exit(failed.length > 0 ? 1 : 0);
