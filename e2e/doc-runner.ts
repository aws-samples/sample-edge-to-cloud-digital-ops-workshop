/**
 * doc-runner.ts — Extract and run annotated bash blocks from workshop .md files.
 *
 * Each bash block immediately followed by <!-- e2e:assert {...} --> is collected.
 * All blocks from a single .md file run in one bash session (variables carry over).
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
}

// ── Parse ─────────────────────────────────────────────────────────────────────

const BASH_FENCE_RE = /^```bash\s*\n([\s\S]*?)^```/gm;
const ASSERT_COMMENT_RE = /<!--\s*e2e:assert\s+(\{[\s\S]*?\})\s*-->/;
const SKIP_COMMENT_RE = /<!--\s*e2e:skip\s*-->/;

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

      blocks.push({ script, assert });
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

function resolveDotPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce((acc, key) => {
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

// ── Run a single .md file's blocks ───────────────────────────────────────────

export async function runDocBlocks(
  mdPath: string,
  subs: RunnerSubstitutions,
  cwd: string,
  onResult: (r: BlockResult) => void
): Promise<void> {
  const md = readFileSync(mdPath, "utf8");
  const blocks = parseBlocks(md);
  const annotated = blocks.filter((b) => b.assert !== null);

  if (annotated.length === 0) return;

  // Build a single bash script with sentinel markers between blocks
  // We run the whole session as one script so variables persist.
  const SENTINEL = "###E2E_BLOCK_SENTINEL###";
  const sessionLines: string[] = ["set -euo pipefail", `export AWS_DEFAULT_REGION="${subs.REGION}"`];

  for (let idx = 0; idx < annotated.length; idx++) {
    const raw = annotated[idx].script;
    const substituted = applySubstitutions(raw, subs);
    sessionLines.push(`echo "${SENTINEL}${idx}"`);
    sessionLines.push(substituted);
  }

  const scriptPath = join(tmpdir(), `e2e-doc-run-${Date.now()}.sh`);
  writeFileSync(scriptPath, sessionLines.join("\n") + "\n", { mode: 0o755 });

  let fullOut = "";
  let fullErr = "";
  const t0 = Date.now();

  try {
    fullOut = execSync(`bash ${scriptPath}`, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    fullOut = e.stdout ?? "";
    fullErr = e.stderr ?? e.message ?? String(err);
  } finally {
    try { unlinkSync(scriptPath); } catch { /* ignore */ }
  }

  // Split stdout by sentinel markers
  const parts = fullOut.split(new RegExp(`${SENTINEL}(\\d+)\\n`));
  // parts[0] = content before first sentinel (preamble)
  // parts[1] = "0", parts[2] = output of block 0
  // parts[3] = "1", parts[4] = output of block 1, etc.

  for (let idx = 0; idx < annotated.length; idx++) {
    const block = annotated[idx];
    const assert = block.assert!;
    const partIdx = idx * 2 + 2;
    const blockOut = parts[partIdx] ?? "";
    const durationMs = idx === annotated.length - 1 ? Date.now() - t0 : 0;

    let error: string | undefined;

    // Evaluate assert
    const assertErr = evaluateAssert(assert, blockOut);
    if (assertErr) {
      error = assertErr;
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
      stderr: idx === annotated.length - 1 ? fullErr : "",
      passed: error === undefined,
      error,
      durationMs,
    });
  }
}
