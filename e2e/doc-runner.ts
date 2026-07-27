/**
 * doc-runner.ts — Extract and run annotated bash blocks from workshop .md files.
 *
 * Each bash block immediately followed by <!-- e2e:assert {...} --> is collected.
 * Blocks from a single .md file each run as their own bash process, with shell
 * vars threaded between them via a scratch env file so shared session state
 * (e.g. `FOO=bar` in one block, read by a later one) still carries over —
 * matching what a participant sees in one interactive shell. Blocks run under
 * `set -a` so even bare (non-`export`ed) assignments thread across; see #74.
 * Substitutions are applied before execution:
 *   ws-slot00        → DEPLOYMENT_ID
 *   000000000000     → ACCOUNT_ID
 *   workshop-platform-000000000000 → SHARED_BUCKET
 *
 * Assert spec (JSON in the comment):
 *   contains      — stdout must include this string
 *   notContains   — stdout must not include this string
 *   jsonPath      — dot-path to extract from stdout JSON (e.g. "jobId")
 *   matches       — regex the jsonPath value must match
 *   jobSucceeds   — after the block, poll until all IoT job executions SUCCEED
 *
 * A block that tears down the shared platform stack (VPCs/EKS/MSK) must also
 * carry a <!-- e2e:platform-teardown --> comment alongside its e2e:assert one —
 * runDocBlocks refuses to run it unless the caller opts in (see
 * RunDocBlocksOptions.allowPlatformTeardown).
 *
 * Running each block as its own process (rather than concatenating all
 * blocks into one `set -euo pipefail` script) means a failing block no longer
 * `set -e`-aborts the rest of the session and masks every later block as
 * failed too (see #72). A failing block's own exit status and stderr are
 * reported against that block only, so later blocks get to run and report
 * their own real pass/fail instead of an opaque, masked "expected ... but
 * got: <empty>" diff. A block that genuinely depends on an earlier block's
 * side effect (e.g. a var the earlier block never exported because it
 * failed first) can still fail downstream — but for a real reason.
 */

import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RunnerSubstitutions {
  DEPLOYMENT_ID: string;
  ACCOUNT_ID: string;
  SHARED_BUCKET: string;
  REGION: string;
  GRAPHQL_ENDPOINT?: string;
}

export interface AssertSpec {
  contains?: string;
  notContains?: string;
  jsonPath?: string;
  matches?: string;
  jobSucceeds?: boolean;
}

export interface BlockResult {
  file: string;
  blockIndex: number;
  script: string;
  stdout: string;
  stderr: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

interface RawBlock {
  script: string;
  assert: AssertSpec | null;
  platformTeardown: boolean;
}

// ── Parse ─────────────────────────────────────────────────────────────────────

const BASH_FENCE_RE = /^```bash\s*\n([\s\S]*?)^```/gm;
const ASSERT_COMMENT_RE = /<!--\s*e2e:assert\s+(\{[\s\S]*?\})\s*-->/;
const SKIP_COMMENT_RE = /<!--\s*e2e:skip\s*-->/;
const PLATFORM_TEARDOWN_COMMENT_RE = /<!--\s*e2e:platform-teardown\s*-->/;

function parseBlocks(md: string): RawBlock[] {
  const blocks: RawBlock[] = [];

  // Collect ALL bash code fences regardless of indentation (indented = inside ??? admonition,
  // but those are the CLI equivalents of console steps and should run in e2e).
  const lines = md.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```bash\s*$/.test(line)) {
      // Determine the fence's indentation so we can match the closing fence
      const indent = line.match(/^(\s*)/)?.[1] ?? "";
      const closingFence = new RegExp(`^${indent}\`\`\`\\s*$`);
      const start = i + 1;
      i++;
      while (i < lines.length && !closingFence.test(lines[i])) i++;
      // Strip the common indentation prefix from each line
      const script = lines
        .slice(start, i)
        .map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l))
        .join("\n");
      i++; // skip closing ```

      // Check for skip marker in the next few lines
      const afterLines = lines.slice(i, i + 3).join("\n");
      if (SKIP_COMMENT_RE.test(afterLines)) {
        i++;
        continue;
      }

      // Check for assert marker in the next few lines (may be indented too)
      const assertSearch = lines.slice(i, i + 4).join("\n");
      const assertMatch = assertSearch.match(ASSERT_COMMENT_RE);
      let assert: AssertSpec | null = null;
      if (assertMatch) {
        try {
          assert = JSON.parse(assertMatch[1]) as AssertSpec;
        } catch {
          assert = null;
        }
      }

      // A block that would tear down the shared platform stack must say so
      // explicitly via <!-- e2e:platform-teardown --> — the guard below relies
      // on this annotation rather than pattern-matching the script text.
      const platformTeardown = PLATFORM_TEARDOWN_COMMENT_RE.test(assertSearch);

      blocks.push({ script, assert, platformTeardown });
      continue;
    }

    i++;
  }

  return blocks;
}

// ── Substitute ────────────────────────────────────────────────────────────────

function applySubstitutions(script: string, subs: RunnerSubstitutions): string {
  let out = script
    .replace(/workshop-platform-000000000000/g, subs.SHARED_BUCKET)
    .replace(/ws-slot00/g, subs.DEPLOYMENT_ID)
    .replace(/000000000000/g, subs.ACCOUNT_ID);
  if (subs.GRAPHQL_ENDPOINT) {
    out = out.replace(/__GRAPHQL_ENDPOINT__/g, subs.GRAPHQL_ENDPOINT);
  }
  return out;
}

// ── Assert ────────────────────────────────────────────────────────────────────

// Splits "things[0].thingName" into ["things", "0", "thingName"] so array
// indices (jsonPath results routinely nest results as things[N].field) resolve
// the same way plain object keys do.
function resolveDotPath(obj: unknown, path: string): unknown {
  const keys = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((k) => k.length > 0);
  return keys.reduce((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

// Finds the index of the bracket that closes the one at `start`, treating
// `{`/`[` and `}`/`]` interchangeably as depth markers (a real mismatch just
// fails JSON.parse downstream) while ignoring brackets inside string literals.
function findMatchingBracketEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }

  return -1;
}

// Stdout from doc blocks is often interleaved with non-JSON noise (S3 cp
// progress lines, "Waiting for ..." polling interstitials) and may contain
// more than one JSON value (e.g. one per poll attempt). This walks the whole
// string and extracts every well-formed top-level JSON object/array, in
// order, ignoring brackets found inside string literals or stray/mismatched
// brackets in surrounding prose.
function extractJsonValues(text: string): unknown[] {
  const values: unknown[] = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (ch === "{" || ch === "[") {
      const end = findMatchingBracketEnd(text, i);
      if (end !== -1) {
        try {
          values.push(JSON.parse(text.slice(i, end + 1)));
          i = end + 1;
          continue;
        } catch { /* not valid JSON, keep scanning from i + 1 */ }
      }
    }
    i++;
  }

  return values;
}

function evaluateAssert(assert: AssertSpec, stdout: string): string | null {
  if (assert.contains !== undefined) {
    if (!stdout.includes(assert.contains))
      return `Expected stdout to contain "${assert.contains}" but got:\n${stdout.slice(0, 500)}`;
  }

  if (assert.notContains !== undefined) {
    if (stdout.includes(assert.notContains))
      return `Expected stdout NOT to contain "${assert.notContains}" but got:\n${stdout.slice(0, 500)}`;
  }

  if (assert.jsonPath !== undefined) {
    // Polling loops (e.g. fleet-index checks) echo one JSON blob per attempt
    // interleaved with plain-text status lines; the last blob is the one
    // that reflects the final, successful attempt.
    const values = extractJsonValues(stdout);
    if (values.length === 0) {
      return `Expected JSON output for jsonPath "${assert.jsonPath}" but couldn't find any JSON in stdout:\n${stdout.slice(0, 500)}`;
    }
    const parsed = values[values.length - 1];
    const value = resolveDotPath(parsed, assert.jsonPath);
    if (assert.matches !== undefined) {
      const re = new RegExp(assert.matches);
      if (!re.test(String(value ?? "")))
        return `jsonPath "${assert.jsonPath}" value "${value}" does not match /${assert.matches}/`;
    }
  }

  return null;
}

// ── IoT job poller ────────────────────────────────────────────────────────────

function pollJobUntilDone(
  jobId: string,
  region: string,
  timeoutMs = 900_000,
  pollIntervalMs = 30_000
): void {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";

  while (Date.now() < deadline) {
    const raw = execSync(
      `aws iot list-job-executions-for-job --job-id ${jobId} --region ${region} --output json`,
      { encoding: "utf8" }
    );
    const resp = JSON.parse(raw) as { executionSummaries?: Array<{ jobExecutionSummary?: { status?: string }; thingArn?: string }> };
    const summaries = resp.executionSummaries ?? [];

    const failed = summaries.filter((s) => s.jobExecutionSummary?.status === "FAILED");
    const cancelled = summaries.filter((s) =>
      ["CANCELED", "TIMED_OUT", "REJECTED"].includes(s.jobExecutionSummary?.status ?? "")
    );
    const succeeded = summaries.filter((s) => s.jobExecutionSummary?.status === "SUCCEEDED");
    const inProgress = summaries.filter((s) =>
      ["IN_PROGRESS", "QUEUED"].includes(s.jobExecutionSummary?.status ?? "")
    );

    const statusLine = `  succeeded=${succeeded.length} in_progress=${inProgress.length} failed=${failed.length}`;
    if (statusLine !== lastStatus) {
      console.log(statusLine);
      lastStatus = statusLine;
    }

    if (failed.length > 0) {
      // Fetch details for the first failure
      const thingName = failed[0].thingArn?.split(":thing/")[1] ?? "";
      let details = "";
      if (thingName) {
        try {
          const execRaw = execSync(
            `aws iot describe-job-execution --job-id ${jobId} --thing-name ${thingName} --region ${region} --output json`,
            { encoding: "utf8" }
          );
          const dm = (JSON.parse(execRaw) as { execution?: { statusDetails?: { detailsMap?: Record<string, string> } } })
            .execution?.statusDetails?.detailsMap ?? {};
          details = Object.entries(dm).map(([k, v]) => `${k}: ${v}`).join("; ");
        } catch { /* best-effort */ }
      }
      throw new Error(
        `IoT Job ${jobId}: ${failed.length} device(s) FAILED. ` +
        `${thingName}: ${details || "(no details)"}`
      );
    }

    if (cancelled.length > 0) {
      throw new Error(`IoT Job ${jobId}: ${cancelled.length} device(s) in terminal non-success state`);
    }

    if (inProgress.length === 0 && succeeded.length > 0) {
      console.log(`  IoT Job ${jobId}: all ${succeeded.length} device(s) SUCCEEDED`);
      return;
    }

    execSync(`sleep ${pollIntervalMs / 1000}`);
  }

  throw new Error(`IoT Job ${jobId} timed out after ${timeoutMs}ms`);
}

// ── Platform-stack safety guard ──────────────────────────────────────────────

// The shared platform stack (VPCs, EKS, MSK) is depended on by every participant
// slot. A doc block that could tear it down must never run as a side effect of
// a routine doc-runner pass — only when the caller explicitly opts in. Rather
// than pattern-matching the script text for destructive-looking commands
// (brittle — breaks on rewording, aliasing, or wrapping in a variable), the
// doc author marks the block explicitly with <!-- e2e:platform-teardown -->
// alongside its e2e:assert comment; see parseBlocks above.

export interface RunDocBlocksOptions {
  /** Opt-in to running blocks that would tear down the shared platform stack. Default: false. */
  allowPlatformTeardown?: boolean;
}

// ── Run a single .md file's blocks ───────────────────────────────────────────

export async function runDocBlocks(
  mdPath: string,
  subs: RunnerSubstitutions,
  cwd: string,
  onResult: (r: BlockResult) => void,
  opts?: RunDocBlocksOptions
): Promise<void> {
  const md = readFileSync(mdPath, "utf8");
  const blocks = parseBlocks(md);
  const annotated = blocks.filter((b) => b.assert !== null);

  if (annotated.length === 0) return;

  if (!opts?.allowPlatformTeardown) {
    const blocked = annotated.find((b) => b.platformTeardown);
    if (blocked) {
      throw new Error(
        `${mdPath}: refusing to run a block annotated <!-- e2e:platform-teardown --> ` +
        `(it tears down the shared platform stack). ` +
        `Pass { allowPlatformTeardown: true } (doc-runner-cli: --delete-platform-stack) to opt in.`
      );
    }
  }

  // Each block runs as its own bash process, rather than all blocks
  // concatenated into one `set -euo pipefail` script — a failing block used
  // to abort the whole session, so every later block in the file was reported
  // as failed too (empty stdout, indistinguishable from a real assertion
  // failure). See #72. Session state is threaded between blocks via a scratch
  // env file so a var set in block N is visible in block N+1 — matching what a
  // participant sees running the commands in one interactive shell.
  //
  // Each block runs under `set -a` (allexport), so a *bare* assignment
  // (`JOB_ID=...`, no `export`) is marked for export and captured by the
  // `export -p` dump in the EXIT trap, just like an explicit `export`. Without
  // this, non-exported vars — which the docs use freely — were silently
  // dropped between blocks, so a later block referencing them died with
  // `unbound variable` under `set -u`. See #74.
  //
  // Only vars newly exported or changed relative to one fixed pre-run baseline
  // are persisted — dumping the whole environment via `export -p` would
  // otherwise leak ambient AWS credentials / tokens (already present at
  // baseline) into a plaintext tmp file. The baseline is captured once, up
  // front: diffing against each block's own starting env instead would
  // "forget" vars accumulated by earlier blocks the moment a later block
  // doesn't itself export anything new.
  // Threading is by variable *name*, not by line-diffing raw `export -p`
  // output: an earlier version diffed full `name=value` lines with `comm -13`,
  // which corrupted the env file whenever a threaded value spanned multiple
  // lines (e.g. `RESULT=$(aws ... --output json)` holding pretty-printed JSON)
  // — the value's later lines leaked out as stray commands. Instead we snapshot
  // the set of exported var *names* at baseline, and in each block's EXIT trap
  // emit only the newly-exported names via `declare -p`, which quotes any value
  // (multi-line included) safely. Names-only diffing also keeps the security
  // property: vars already present at baseline (ambient AWS creds/tokens) are
  // never re-emitted into the plaintext tmp file.
  const runToken = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const envFile = join(tmpdir(), `e2e-doc-run-${runToken}-env.sh`);
  const baselineFile = join(tmpdir(), `e2e-doc-run-${runToken}-baseline.sh`);
  writeFileSync(envFile, "", { mode: 0o600 });
  // `compgen -e` lists exported variable *names*, one per line — no quoting
  // gymnastics needed to parse them out of `export -p`.
  writeFileSync(
    baselineFile,
    execSync(`bash -c 'compgen -e | sort'`, { encoding: "utf8" }),
    { mode: 0o600 }
  );

  const results: Array<{ stdout: string; stderr: string; blockFailed: boolean; durationMs: number }> = [];

  try {
    for (let idx = 0; idx < annotated.length; idx++) {
      const substituted = applySubstitutions(annotated[idx].script, subs);
      const scriptLines = [
        "set -euo pipefail",
        `export AWS_DEFAULT_REGION="${subs.REGION}"`,
        `source "${envFile}"`,
        // On exit, persist only vars exported by this (or an earlier) block —
        // names not present at baseline — re-emitted with `declare -p` so
        // multi-line values survive intact. See #74.
        `trap 'for _v in $(compgen -e | sort | comm -13 "${baselineFile}" -); do declare -p "$_v"; done > "${envFile}"' EXIT`,
        // allexport: bare `FOO=bar` assignments (no explicit `export`) are
        // marked for export so they thread to later blocks. See #74.
        "set -a",
        substituted,
      ];
      const scriptPath = join(tmpdir(), `e2e-doc-run-${runToken}-${idx}.sh`);
      writeFileSync(scriptPath, scriptLines.join("\n") + "\n", { mode: 0o755 });

      let stdout = "";
      let stderr = "";
      let blockFailed = false;
      const blockT0 = Date.now();
      try {
        stdout = execSync(`bash ${scriptPath}`, {
          cwd,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
          maxBuffer: 10 * 1024 * 1024,
        });
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        stdout = e.stdout ?? "";
        stderr = e.stderr ?? e.message ?? String(err);
        blockFailed = true;
      } finally {
        try { unlinkSync(scriptPath); } catch { /* ignore */ }
      }

      results.push({ stdout, stderr, blockFailed, durationMs: Date.now() - blockT0 });
    }
  } finally {
    try { unlinkSync(envFile); } catch { /* ignore */ }
    try { unlinkSync(baselineFile); } catch { /* ignore */ }
  }

  for (let idx = 0; idx < annotated.length; idx++) {
    const block = annotated[idx];
    const assert = block.assert!;
    const { stdout: blockOut, stderr: blockErr, blockFailed, durationMs } = results[idx];

    let error: string | undefined;

    // Evaluate assert
    const assertErr = evaluateAssert(assert, blockOut);
    if (assertErr) {
      error = assertErr;
    }

    // A block can fail (non-zero exit) even when its partial stdout happens
    // to satisfy the assert — surface that as a failure too, with the real
    // stderr/exit detail rather than a masked, empty diff.
    if (blockFailed) {
      const detail = blockErr.trim() ? blockErr.trim().slice(0, 500) : "(no stderr captured)";
      error = error
        ? `${error}\n\nBlock command also exited non-zero:\n${detail}`
        : `Block command exited non-zero:\n${detail}`;
    }

    // If jobSucceeds: true, extract jobId from the block output and poll
    if (!error && assert.jobSucceeds) {
      let jobId: string | undefined;
      // Last JSON value with a jobId wins, matching polling loops that echo
      // progress JSON until the final successful attempt.
      for (const parsed of extractJsonValues(blockOut)) {
        const id = (parsed as { jobId?: string } | undefined)?.jobId;
        if (id) jobId = id;
      }
      if (!jobId) {
        // Fallback: look for jobId in the combined output
        const m = blockOut.match(/"jobId"\s*:\s*"([^"]+)"/);
        if (m) jobId = m[1];
      }
      if (!jobId) {
        error = `jobSucceeds: true but could not extract jobId from block output:\n${blockOut.slice(0, 500)}`;
      } else {
        try {
          pollJobUntilDone(jobId, subs.REGION);
        } catch (pollErr: unknown) {
          error = pollErr instanceof Error ? pollErr.message : String(pollErr);
        }
      }
    }

    onResult({
      file: mdPath,
      blockIndex: idx,
      script: block.script,
      stdout: blockOut,
      stderr: blockErr,
      passed: error === undefined,
      error,
      durationMs,
    });
  }
}
