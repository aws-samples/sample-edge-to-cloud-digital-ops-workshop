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

  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`**${totalPassed}/${totalBlocks} blocks passed across ${fileSummaries.length} file(s)**`);
  lines.push("");

  return lines.join("\n");
}
