/**
 * report-writer.ts — Renders a Markdown workshop run report from the
 * structured evidence collected by runner.ts.
 *
 * Output: e2e/reports/run-<deploymentId>-<timestamp>.md
 *
 * Each phase gets its own H2 section. Every check gets a pass/fail badge.
 * Rich evidence blocks (MQTT samples, SDK responses, SQL rows, screenshots,
 * SSM stdout) are embedded as collapsible <details> sections.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ── Types (mirrored from runner.ts — keep in sync) ────────────────────────────

export interface CheckEvidence {
  /** Arbitrary key → value. Strings are rendered verbatim (may be JSON/plain).
   *  "screenshot" key → base64-encoded PNG → rendered as inline <img>. */
  [label: string]: string;
}

export interface CheckResult {
  name: string;
  phase: string;
  passed: boolean;
  durationMs: number;
  error?: string;
  data?: Record<string, unknown>;
  evidence?: CheckEvidence;
}

export interface PhaseResult {
  name: string;
  startedAt: string;
  durationMs: number;
  checksTotal: number;
  checksPassed: number;
  checksFailed: number;
}

export interface RunReport {
  deploymentId: string;
  region: string;
  startedAt: string;
  suiteDurationMs: number;
  totalPassed: number;
  totalFailed: number;
  phases: PhaseResult[];
  checks: CheckResult[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function badge(passed: boolean): string {
  return passed ? "✅ PASS" : "❌ FAIL";
}

function ms(n: number): string {
  return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    timeZoneName: "short",
  });
}

function jsonBlock(obj: unknown): string {
  return "```json\n" + JSON.stringify(obj, null, 2) + "\n```";
}

function textBlock(s: string, lang = ""): string {
  return "```" + lang + "\n" + s.trimEnd() + "\n```";
}

function details(summary: string, body: string): string {
  return `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>\n`;
}

function screenshotImg(b64: string, alt: string): string {
  return `<img alt="${alt}" src="data:image/png;base64,${b64}" style="max-width:100%;border:1px solid #ccc;border-radius:4px;" />\n`;
}

// ── Phase-level section writers ───────────────────────────────────────────────

function renderCheck(c: CheckResult): string {
  const lines: string[] = [];
  const dataStr = c.data
    ? Object.entries(c.data).map(([k, v]) => `\`${k}\`=\`${v}\``).join(" · ")
    : "";

  lines.push(`#### ${badge(c.passed)} ${c.name} — ${ms(c.durationMs)}`);
  if (dataStr) lines.push(`> ${dataStr}`);
  if (!c.passed && c.error) {
    lines.push("");
    lines.push(textBlock(c.error, ""));
  }

  if (c.evidence) {
    for (const [label, value] of Object.entries(c.evidence)) {
      if (label === "screenshot") {
        lines.push("");
        lines.push(details(
          "🖥 Screenshot",
          screenshotImg(value, c.name),
        ));
      } else if (label === "screenshot_dashboard") {
        lines.push("");
        lines.push(details(
          "🖥 Screenshot — Dashboard page",
          screenshotImg(value, "Dashboard"),
        ));
      } else {
        // Try to pretty-print JSON; fall back to plain text block
        let rendered: string;
        try {
          rendered = jsonBlock(JSON.parse(value));
        } catch {
          rendered = textBlock(value);
        }
        lines.push("");
        lines.push(details(`📋 ${label}`, rendered));
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}

function renderPhase(phase: PhaseResult, checks: CheckResult[]): string {
  const lines: string[] = [];
  const statusIcon = phase.checksFailed > 0 ? "❌" : "✅";

  lines.push(`## ${statusIcon} ${phase.name}`);
  lines.push("");
  lines.push(`| | |`);
  lines.push(`|---|---|`);
  lines.push(`| Started | ${fmtDate(phase.startedAt)} |`);
  lines.push(`| Duration | ${ms(phase.durationMs)} |`);
  lines.push(`| Checks | ${phase.checksPassed}/${phase.checksTotal} passed |`);
  lines.push("");

  for (const c of checks) {
    lines.push(renderCheck(c));
  }

  return lines.join("\n");
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function writeMarkdownReport(report: RunReport, reportDir: string): string {
  const lines: string[] = [];

  // ── Title & summary ────────────────────────────────────────────────────────
  const overallIcon = report.totalFailed === 0 ? "✅" : "❌";
  lines.push(`# ${overallIcon} Workshop E2E Run — \`${report.deploymentId}\``);
  lines.push("");
  lines.push(`> Generated ${fmtDate(report.startedAt)} · Region \`${report.region}\``);
  lines.push("");
  lines.push(`## Summary`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Run started | ${fmtDate(report.startedAt)} |`);
  lines.push(`| Total duration | ${ms(report.suiteDurationMs)} |`);
  lines.push(`| Checks passed | **${report.totalPassed}** |`);
  lines.push(`| Checks failed | **${report.totalFailed}** |`);
  lines.push("");

  // Phase overview table
  lines.push(`### Phase Overview`);
  lines.push("");
  lines.push(`| Phase | Duration | Result |`);
  lines.push(`|---|---|---|`);
  for (const p of report.phases) {
    const icon = p.checksFailed > 0 ? "❌" : "✅";
    lines.push(`| ${p.name} | ${ms(p.durationMs)} | ${icon} ${p.checksPassed}/${p.checksTotal} |`);
  }
  lines.push("");

  // ── Per-phase detail ───────────────────────────────────────────────────────
  for (const phase of report.phases) {
    const phaseChecks = report.checks.filter((c) => c.phase === phase.name);
    lines.push(renderPhase(phase, phaseChecks));
    lines.push("---");
    lines.push("");
  }

  const md = lines.join("\n");
  mkdirSync(reportDir, { recursive: true });
  const slug = report.startedAt.slice(0, 19).replace(/:/g, "-");
  const mdPath = join(reportDir, `run-${report.deploymentId}-${slug}.md`);
  writeFileSync(mdPath, md);
  return mdPath;
}
