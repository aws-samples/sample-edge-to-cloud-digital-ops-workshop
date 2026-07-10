/**
 * doc-runner.test.ts — Unit tests for runDocBlocks against synthetic .md fixtures.
 *
 * These run entirely locally (bash + node, no AWS calls) so they exercise the
 * block-parsing / execution / assertion logic in isolation from a live deployment.
 * Run with: pnpm --filter edge-digital-ops-e2e test:unit
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDocBlocks, type BlockResult, type RunnerSubstitutions, type RunDocBlocksOptions } from "./doc-runner.js";

const SUBS: RunnerSubstitutions = {
  DEPLOYMENT_ID: "ws-test00",
  ACCOUNT_ID: "111111111111",
  SHARED_BUCKET: "test-bucket",
  REGION: "us-east-1",
};

function writeDoc(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "doc-runner-test-"));
  const path = join(dir, "doc.md");
  writeFileSync(path, content);
  return path;
}

async function run(mdContent: string, opts?: RunDocBlocksOptions): Promise<BlockResult[]> {
  const path = writeDoc(mdContent);
  const results: BlockResult[] = [];
  try {
    await runDocBlocks(path, SUBS, process.cwd(), (r) => results.push(r), opts);
  } finally {
    rmSync(path, { force: true, recursive: true });
  }
  return results;
}

test("a failing block does not mask later, otherwise-passing blocks (issue #72 repro)", async () => {
  const md = [
    "```bash",
    "false",
    'echo "UPDATE_OK"',
    "```",
    '<!-- e2e:assert {"contains": "UPDATE_OK"} -->',
    "",
    "```bash",
    "echo '{\"indexStatus\":\"ACTIVE\"}'",
    "```",
    '<!-- e2e:assert {"jsonPath": "indexStatus", "matches": "ACTIVE"} -->',
  ].join("\n");

  const results = await run(md);
  assert.equal(results.length, 2);
  assert.equal(results[0].passed, false);
  assert.equal(results[1].passed, true, `block 2 should pass independently but got: ${results[1].error}`);
});

test("exported vars still thread between blocks", async () => {
  const md = [
    "```bash",
    "export FOO=bar",
    'echo "SET_OK"',
    "```",
    '<!-- e2e:assert {"contains": "SET_OK"} -->',
    "",
    "```bash",
    'echo "$FOO"',
    "```",
    '<!-- e2e:assert {"contains": "bar"} -->',
  ].join("\n");

  const results = await run(md);
  assert.equal(results[0].passed, true);
  assert.equal(results[1].passed, true, `expected FOO to thread through but got: ${results[1].stdout}`);
});

test("a block marked e2e:skip never runs", async () => {
  const md = [
    "```bash",
    "false",
    "```",
    "<!-- e2e:skip -->",
    "",
    "```bash",
    'echo "RAN"',
    "```",
    '<!-- e2e:assert {"contains": "RAN"} -->',
  ].join("\n");

  const results = await run(md);
  assert.equal(results.length, 1);
  assert.equal(results[0].passed, true);
});

test("platform-teardown blocks are refused unless explicitly allowed", async () => {
  const md = [
    "```bash",
    'echo "TEARDOWN_OK"',
    "```",
    '<!-- e2e:assert {"contains": "TEARDOWN_OK"} -->',
    "<!-- e2e:platform-teardown -->",
  ].join("\n");

  await assert.rejects(() => run(md), /platform-teardown/);

  const results = await run(md, { allowPlatformTeardown: true });
  assert.equal(results.length, 1);
  assert.equal(results[0].passed, true);
});

test("a block that exits non-zero reports its own failure, not a masked empty diff", async () => {
  const md = ["```bash", "exit 3", "```", '<!-- e2e:assert {"contains": "anything"} -->'].join("\n");

  const results = await run(md);
  assert.equal(results.length, 1);
  assert.equal(results[0].passed, false);
  assert.match(results[0].error ?? "", /exited non-zero/);
});

test("substitutions are applied before a block runs", async () => {
  const md = [
    "```bash",
    "echo 'ws-slot00 000000000000'",
    "```",
    '<!-- e2e:assert {"contains": "ws-test00 111111111111"} -->',
  ].join("\n");

  const results = await run(md);
  assert.equal(results[0].passed, true, `expected substitution but got stdout: ${results[0].stdout}`);
});
