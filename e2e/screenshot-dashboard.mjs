#!/usr/bin/env node
// Screenshot the per-slot cloud-analytics dashboard (fleet view + freshness /
// query-latency panels, plus the ingest-volume / freshness-over-time /
// latency-over-time trend panels added in #270) and dump its visible text so
// the numbers can be read without OCR. Self-contained: spawns its own
// `kubectl port-forward` to the in-cluster `cloud-analytics-dashboard` service
// (no public endpoint) and tears it down on exit.
//
// Requires: kubectl context pointing at the workshop EKS cluster, and Playwright
// (already present in e2e/node_modules — `pnpm --filter e2e exec playwright install chromium`
// if the browser is missing).
//
// Usage:
//   node e2e/screenshot-dashboard.mjs --slot ws-slot42 --out /tmp/dash.png
//   WORKSHOP_TEST_SLOT=ws-slot42 node e2e/screenshot-dashboard.mjs
//   node e2e/screenshot-dashboard.mjs --slot ws-slot42 --skip-panel-assert   # screenshot only, no exit-code gate
//
// Flags (all optional except a slot from --slot or WORKSHOP_TEST_SLOT):
//   --slot <id>     slot / k8s namespace (default: $WORKSHOP_TEST_SLOT)
//   --out <path>    PNG output path (default: /tmp/<slot>-dashboard.png)
//   --port <n>      local port to forward to (default: 8899)
//   --settle <ms>   how long to let the freshness panels poll before the shot (default: 12000)
//   --skip-panel-assert   don't fail the process on a missing/empty panel (still prints the text dump)
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

// #271 — panel titles every one of these MUST be present in the page's
// visible text (see cloud-dashboard/src/app/page.tsx). Catches a panel that
// silently failed to render (e.g. a thrown component) rather than just one
// that's empty of data.
const REQUIRED_PANEL_TITLES = [
  'Ingest Volume Over Time',
  'Data Freshness Over Time (log scale)',
  'Query Latency Over Time (log scale)',
];

// "Collecting samples…" is the not-yet-populated placeholder each of the
// three trend panels renders until it has at least two data points (see
// page.tsx's `chartData.length < 2` guard). Its absence is a good proxy for
// "the volume series is non-zero" from the design doc's testing section —
// the ingest-volume panel only clears this placeholder once /api/volume has
// returned real rows.
const EMPTY_PANEL_PLACEHOLDER = 'Collecting samples';

function assertPanels(text) {
  const missing = REQUIRED_PANEL_TITLES.filter((title) => !text.includes(title));
  if (missing.length) {
    throw new Error(`dashboard is missing panel(s): ${missing.join(', ')}`);
  }
  if (text.includes(EMPTY_PANEL_PLACEHOLDER)) {
    throw new Error(
      'one or more time-series panels never received a data point (still showing ' +
        `"${EMPTY_PANEL_PLACEHOLDER}") — expected once the dashboard has been open ` +
        'for --settle ms against a live or mock data source'
    );
  }
}

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

const slot = arg('slot', process.env.WORKSHOP_TEST_SLOT);
if (!slot) {
  console.error('error: no slot — pass --slot ws-slotNN or set WORKSHOP_TEST_SLOT');
  process.exit(2);
}
const port = parseInt(arg('port', '8899'), 10);
const out = arg('out', `/tmp/${slot}-dashboard.png`);
const settle = parseInt(arg('settle', '12000'), 10);
const skipPanelAssert = process.argv.includes('--skip-panel-assert');
const svc = 'svc/cloud-analytics-dashboard';

const waitForPort = (p, timeoutMs) =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const s = net.connect(p, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(); });
      s.on('error', () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error(`port ${p} never opened`));
        else setTimeout(tick, 300);
      });
    };
    tick();
  });

// Reuse an already-open forwarder on this port if present, else start one.
let pf = null;
const alreadyOpen = await waitForPort(port, 500).then(() => true).catch(() => false);
if (!alreadyOpen) {
  console.error(`starting port-forward ${svc} ${port}:3000 in ${slot} ...`);
  pf = spawn('kubectl', ['port-forward', '-n', slot, svc, `${port}:3000`], { stdio: 'ignore' });
  await waitForPort(port, 30000);
} else {
  console.error(`port ${port} already open — reusing existing forwarder`);
}

const url = `http://localhost:${port}`;
try {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  // The dashboard holds persistent SSE connections (the RisingWave/TimescaleDB
  // push path), so 'networkidle' never fires — wait for the DOM, then let the
  // freshness panels poll a few cycles via the settle delay.
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(settle);
  await page.screenshot({ path: out, fullPage: true });
  const text = await page.evaluate(() => document.body.innerText);
  await browser.close();
  console.error(`screenshot -> ${out}`);
  console.log(text);

  if (!skipPanelAssert) {
    assertPanels(text);
    console.error('panel assertions passed — all three time-series panels present and populated');
  }
} finally {
  if (pf) pf.kill('SIGTERM');
}
