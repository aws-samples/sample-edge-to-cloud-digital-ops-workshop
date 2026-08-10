/**
 * report.ts — Pure helpers for rendering the doc-runner run summary to a
 * markdown report file. Split out from doc-runner-cli.ts so they can be
 * unit-tested without triggering the CLI's top-level AWS calls.
 */

import { join } from "node:path";
import type { BlockResult } from "./doc-runner.js";

export interface ReportRunInfo {
  deploymentId: string;
  region: string;
  accountId: string;
  runDate: string;
}

export interface FileSummaryLike {
  file: string;
  results: BlockResult[];
}

// Resolves the --report-out/E2E_REPORT_OUT value to a concrete file path.
// A path ending in .md is used verbatim; anything else (including the
// default) is treated as a directory and gets YYYY-MM-DD-<slot>.md appended.
export function resolveReportPath(rawValue: string, repoRoot: string, deploymentId: string, runDate: string): string {
  const target = join(repoRoot, rawValue);
  return target.endsWith(".md") ? target : join(target, `${runDate}-${deploymentId}.md`);
}

export function renderReport(fileSummaries: FileSummaryLike[], info: ReportRunInfo): string {
  const lines: string[] = [];
  lines.push(`# Doc-runner report — ${info.deploymentId}`);
  lines.push("");
  lines.push(`- **Deployment ID:** ${info.deploymentId}`);
  lines.push(`- **Region:** ${info.region}`);
  lines.push(`- **Account ID:** ${info.accountId}`);
  lines.push(`- **Date:** ${info.runDate}`);
  lines.push("");
  lines.push("## Per-file results");
  lines.push("");

  let totalPassed = 0;
  let totalBlocks = 0;
  for (const { file, results } of fileSummaries) {
    const failed = results.filter((r) => !r.passed);
    totalPassed += results.length - failed.length;
    totalBlocks += results.length;
    const status = results.length === 0 ? "(no annotated blocks)" : `${results.length - failed.length}/${results.length} passed`;
    lines.push(`- ${failed.length > 0 ? "✗" : "✓"} ${file} — ${status}`);
  }

  // Data-freshness measurements captured from blocks annotated
  // captureFreshness (the CLI equivalent of the dashboard's freshness panel).
  // One row per tier, ordered fastest-first, so a report shows the same
  // three-tier freshness ladder side by side that the live dashboard renders.
  const measurements = fileSummaries
    .flatMap(({ results }) => results.map((r) => r.freshness).filter((f): f is NonNullable<typeof f> => f != null))
    .sort((a, b) => (a.freshness_ms ?? Infinity) - (b.freshness_ms ?? Infinity));

  if (measurements.length > 0) {
    lines.push("");
    lines.push("## Data freshness");
    lines.push("");
    lines.push("Measured `now − MAX(timestamp)` per storage tier — the CLI equivalent of the dashboard's Data Freshness chart.");
    lines.push("");
    lines.push("| Tier | Freshness | Rows |");
    lines.push("|---|---|---|");
    for (const m of measurements) {
      const fresh = m.freshness_ms == null ? "—" : `${m.freshness_ms.toLocaleString()} ms`;
      const rows = m.rows == null ? "—" : String(m.rows);
      lines.push(`| ${m.tier} | ${fresh} | ${rows} |`);
    }
  }

  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`**${totalPassed}/${totalBlocks} blocks passed across ${fileSummaries.length} file(s)**`);
  lines.push("");

  return lines.join("\n");
}
