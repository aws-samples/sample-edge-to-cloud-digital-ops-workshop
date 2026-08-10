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
 *   contains         — stdout must include this string
 *   notContains      — stdout must not include this string
 *   jsonPath         — dot-path to extract from stdout JSON (e.g. "jobId")
 *   matches          — regex the jsonPath value must match
 *   jobSucceeds      — after the block, poll until all IoT job executions SUCCEED
 *   captureFreshness — record a data-freshness measurement from this block into
 *                      the run report. The block must emit a JSON object on
 *                      stdout shaped {"tier","freshness_ms"[,"rows"]}; the last
 *                      such object wins. Used by the Block-5 CLI freshness step
 *                      to log RisingWave / TimescaleDB / Athena freshness side
 *                      by side, the same three-tier comparison the dashboard
 *                      renders (see workshop/04-analytics/block-5-dashboard.md).
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

/** Which workshop persona a block belongs to. A cluster-scoped install
 *  (cert-manager, an operator, a default StorageClass) is `admin`; a
 *  namespace-scoped operation a participant runs against their own slot is
 *  `participant`. Omitted = `any`: setup/shared blocks that both personas run
 *  (e.g. `aws eks update-kubeconfig`, an Athena query, an IoT job). The runner's
 *  --persona flag selects which blocks execute; see RunDocBlocksOptions.persona. */
export type Persona = "admin" | "participant";

export interface AssertSpec {
  contains?: string;
  notContains?: string;
  jsonPath?: string;
  matches?: string;
  jobSucceeds?: boolean;
  /** Poll ceiling for jobSucceeds, in minutes. Defaults to 15. Longer-running
   *  jobs (e.g. the K3s bootstrap, which the docs allow 45 min) set this higher. */
  jobTimeoutMinutes?: number;
  /** Restrict this block to one persona. Omitted = runs under both. */
  persona?: Persona;
  /** Record a data-freshness measurement from this block into the run report.
   *  The block must print a JSON object on stdout shaped
   *  {"tier": "...", "freshness_ms": <number>, "rows"?: <number>}; the last such
   *  object in stdout wins. */
  captureFreshness?: boolean;
}

/** One data-freshness measurement captured from a block annotated
 *  captureFreshness — the CLI-equivalent of a data-freshness dashboard tile.
 *  Aggregated across all files into the run report. */
export interface FreshnessMeasurement {
  tier: string;
  freshness_ms: number | null;
  rows?: number;
  file: string;
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
  /** Set when the block was annotated captureFreshness and emitted a parseable
   *  measurement — surfaced in the run report's data-freshness table. */
  freshness?: FreshnessMeasurement;
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

function evaluateAssert(assert: AssertSpec, stdout: string, subs: RunnerSubstitutions): string | null {
  // The command is run with placeholders substituted (ws-slot00 → the real
  // slot), so the *expected* text must be substituted the same way — otherwise
  // a doc that asserts `contains: "ws-slot00"` fails on every non-ws-slot00
  // slot even though the output is correct for that slot.
  if (assert.contains !== undefined) {
    const expected = applySubstitutions(assert.contains, subs);
    if (!stdout.includes(expected))
      return `Expected stdout to contain "${expected}" but got:\n${stdout.slice(0, 500)}`;
  }

  if (assert.notContains !== undefined) {
    const expected = applySubstitutions(assert.notContains, subs);
    if (stdout.includes(expected))
      return `Expected stdout NOT to contain "${expected}" but got:\n${stdout.slice(0, 500)}`;
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
      const pattern = applySubstitutions(assert.matches, subs);
      const re = new RegExp(pattern);
      if (!re.test(String(value ?? "")))
        return `jsonPath "${assert.jsonPath}" value "${value}" does not match /${pattern}/`;
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

  // On timeout, name the device(s) still not done so the operator can triage
  // immediately (stuck/offline device vs. a genuinely slow rollout) without a
  // re-run. Re-fetch a final snapshot — the loop exits between polls.
  let stuck = "";
  try {
    const raw = execSync(
      `aws iot list-job-executions-for-job --job-id ${jobId} --region ${region} --output json`,
      { encoding: "utf8" }
    );
    const resp = JSON.parse(raw) as { executionSummaries?: Array<{ jobExecutionSummary?: { status?: string }; thingArn?: string }> };
    const pending = (resp.executionSummaries ?? []).filter((s) =>
      ["IN_PROGRESS", "QUEUED"].includes(s.jobExecutionSummary?.status ?? "")
    );
    stuck = pending
      .map((s) => `${s.thingArn?.split(":thing/")[1] ?? "?"}=${s.jobExecutionSummary?.status}`)
      .join(", ");
  } catch { /* best-effort */ }

  throw new Error(
    `IoT Job ${jobId} timed out after ${timeoutMs}ms` +
    (stuck ? ` — still pending: ${stuck}. Check that these device(s) are online and running the IoT Device Client.` : "")
  );
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
  /** Run only blocks for this persona (plus untagged "any" blocks). Omitted =
   *  run every annotated block regardless of persona tag (the default full run). */
  persona?: Persona;
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
  // A block runs when it has an assert AND (no persona filter is active, or the
  // block is untagged ("any"), or its tag matches the requested persona). This
  // is applied before indexing/threading so the block numbers and the scratch
  // env file only ever reflect blocks that actually run for this persona.
  const annotated = blocks.filter(
    (b) =>
      b.assert !== null &&
      (opts?.persona === undefined ||
        b.assert.persona === undefined ||
        b.assert.persona === opts.persona)
  );

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
    const assertErr = evaluateAssert(assert, blockOut, subs);
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
          const timeoutMs = assert.jobTimeoutMinutes
            ? assert.jobTimeoutMinutes * 60_000
            : undefined;
          pollJobUntilDone(jobId, subs.REGION, timeoutMs);
        } catch (pollErr: unknown) {
          error = pollErr instanceof Error ? pollErr.message : String(pollErr);
        }
      }
    }

    // Capture a data-freshness measurement for the run report. The block emits
    // {"tier","freshness_ms"[,"rows"]} on stdout; the last such object wins
    // (matching the polling-loop convention used elsewhere in this file). Only
    // recorded when the block otherwise passed — a failed query's freshness
    // number is meaningless.
    let freshness: FreshnessMeasurement | undefined;
    if (!error && assert.captureFreshness) {
      for (const parsed of extractJsonValues(blockOut)) {
        const obj = parsed as { tier?: unknown; freshness_ms?: unknown; rows?: unknown };
        if (obj && typeof obj.tier === "string" && "freshness_ms" in obj) {
          const ms = obj.freshness_ms;
          freshness = {
            tier: obj.tier,
            freshness_ms: typeof ms === "number" ? ms : ms == null ? null : Number(ms),
            rows: typeof obj.rows === "number" ? obj.rows : undefined,
            file: mdPath,
          };
        }
      }
      if (!freshness) {
        error = `captureFreshness: true but no {"tier","freshness_ms"} JSON found in block output:\n${blockOut.slice(0, 500)}`;
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
      freshness,
    });
  }
}
