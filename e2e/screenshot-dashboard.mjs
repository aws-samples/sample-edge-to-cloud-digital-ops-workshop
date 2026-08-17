#!/usr/bin/env node
// Screenshot the per-slot cloud-analytics dashboard (fleet view + freshness /
// query-latency panels) and dump its visible text so the numbers can be read
// without OCR. Self-contained: spawns its own `kubectl port-forward` to the
// in-cluster `cloud-analytics-dashboard` service (no public endpoint) and tears
// it down on exit.
//
// Requires: kubectl context pointing at the workshop EKS cluster, and Playwright
// (already present in e2e/node_modules — `pnpm --filter e2e exec playwright install chromium`
// if the browser is missing).
//
// Usage:
//   node e2e/screenshot-dashboard.mjs --slot ws-slot42 --out /tmp/dash.png
//   WORKSHOP_TEST_SLOT=ws-slot42 node e2e/screenshot-dashboard.mjs
//
// Flags (all optional except a slot from --slot or WORKSHOP_TEST_SLOT):
//   --slot <id>     slot / k8s namespace (default: $WORKSHOP_TEST_SLOT)
//   --out <path>    PNG output path (default: /tmp/<slot>-dashboard.png)
//   --port <n>      local port to forward to (default: 8899)
//   --settle <ms>   how long to let the freshness panels poll before the shot (default: 12000)
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

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
} finally {
  if (pf) pf.kill('SIGTERM');
}
