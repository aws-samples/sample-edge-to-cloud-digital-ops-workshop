#!/usr/bin/env node
/**
 * Generates YouTube cover art (1280x720) for each workshop session video.
 * One cohesive "edge-to-cloud" visual system, one accent color + motif per session.
 * Run: node video-covers/generate-covers.mjs
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT_DIR = dirname(fileURLToPath(import.meta.url));
const W = 1280;
const H = 720;

const SESSIONS = [
  {
    n: 0,
    slug: "00-overview",
    kicker: "OVERVIEW",
    label: "COURSE OVERVIEW",
    title: "Edge-to-Cloud Digital Operations",
    goal: "The same sensor reading, edge to cloud — and the freshness-vs-scale tradeoffs behind the architecture.",
    accent: "#2dd4bf",
    accent2: "#6366f1",
    footer: "7 sessions · 4 hours each",
    motif: "overview",
  },
  {
    n: 1,
    slug: "01-observe",
    kicker: "OBSERVE",
    title: "The Data in Motion",
    goal: "Trace telemetry from EC2 → IoT Core → Firehose → S3 → Athena, and measure data freshness.",
    accent: "#22d3ee",
    accent2: "#0ea5e9",
    blocks: "4 blocks",
    motif: "pipeline",
  },
  {
    n: 2,
    slug: "02-control",
    kicker: "CONTROL",
    title: "Fleet Management with IoT Jobs",
    goal: "Push a script update to the whole fleet at once and operate devices at scale.",
    accent: "#fbbf24",
    accent2: "#f59e0b",
    blocks: "5 blocks",
    motif: "fleet",
  },
  {
    n: 3,
    slug: "03-state",
    kicker: "STATE",
    title: "Device Shadows & Failure Detection",
    goal: "Model device state with named shadows and detect failure through shadow staleness.",
    accent: "#a78bfa",
    accent2: "#8b5cf6",
    blocks: "3 blocks",
    motif: "shadow",
  },
  {
    n: 4,
    slug: "04-analytics",
    kicker: "ANALYTICS",
    title: "The Cloud Telemetry Plane",
    goal: "Four stores, one metric — RisingWave, TimescaleDB, Timestream & Iceberg, side by side.",
    accent: "#34d399",
    accent2: "#10b981",
    blocks: "6 blocks",
    motif: "stores",
  },
  {
    n: 5,
    slug: "05-edge-infra",
    kicker: "EDGE INFRASTRUCTURE",
    title: "K3s Cluster Deployment",
    goal: "Stand up a K3s cluster across edge EC2 and deploy the full edge pipeline via Helm.",
    accent: "#60a5fa",
    accent2: "#3b82f6",
    blocks: "5 blocks",
    motif: "cluster",
  },
  {
    n: 6,
    slug: "06-hmi",
    kicker: "HMI",
    title: "The Edge Operator Interface",
    goal: "Visualize the site live, explore digital-ops metrics, and simulate a network failure.",
    accent: "#f472b6",
    accent2: "#ec4899",
    blocks: "4 blocks",
    motif: "hmi",
  },
  {
    n: 7,
    slug: "07-capstone",
    kicker: "CAPSTONE",
    title: "Architecture Review & Production Path",
    goal: "Review the full build, discuss fleet scale and day-2 ops, and map it to production.",
    accent: "#facc15",
    accent2: "#eab308",
    blocks: "4 blocks",
    motif: "summit",
  },
];

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---- motif renderers (right-hand icon cluster, centered ~x=980 y=300) ----
function motif(kind, a, a2) {
  const cx = 985;
  const cy = 300;
  const node = (x, y, r, fill = a, extra = "") =>
    `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" ${extra}/>`;
  const line = (x1, y1, x2, y2, o = 0.5) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${a}" stroke-width="2" opacity="${o}"/>`;

  switch (kind) {
    case "pipeline": {
      // sensor -> broker -> stream -> store, connected with a flowing dashed line
      const xs = [cx - 150, cx - 50, cx + 50, cx + 150];
      let s = "";
      for (let i = 0; i < xs.length - 1; i++)
        s += `<line x1="${xs[i]}" y1="${cy}" x2="${xs[i + 1]}" y2="${cy}" stroke="${a}" stroke-width="3" stroke-dasharray="6 6" opacity="0.7"><animate attributeName="stroke-dashoffset" from="24" to="0" dur="1.2s" repeatCount="indefinite"/></line>`;
      xs.forEach((x, i) => {
        s += node(x, cy, 26, "url(#nodeGrad)", `stroke="${a}" stroke-width="2.5"`);
      });
      // little icons: waveform on first
      s += `<path d="M ${cx - 162} ${cy} q 6 -14 12 0 t 12 0 t 12 0" fill="none" stroke="#0a0e1a" stroke-width="2.5"/>`;
      s += `<rect x="${cx + 138}" y="${cy - 12}" width="24" height="24" rx="3" fill="none" stroke="#0a0e1a" stroke-width="2.5"/>`;
      return s;
    }
    case "fleet": {
      // one hub pushing to 3 devices
      let s = node(cx, cy - 90, 30, "url(#nodeGrad)", `stroke="${a}" stroke-width="3"`);
      s += `<path d="M ${cx - 10} ${cy - 98} l 10 10 l 18 -18" fill="none" stroke="#0a0e1a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
      const dev = [cx - 120, cx, cx + 120];
      dev.forEach((x) => {
        s += line(cx, cy - 60, x, cy + 40, 0.6);
        s += `<rect x="${x - 30}" y="${cy + 40}" width="60" height="90" rx="8" fill="url(#nodeGrad)" stroke="${a}" stroke-width="2.5"/>`;
        s += `<circle cx="${x}" cy="${cy + 115}" r="5" fill="${a}"/>`;
        s += `<rect x="${x - 18}" y="${cy + 54}" width="36" height="6" rx="3" fill="${a}" opacity="0.6"/>`;
      });
      return s;
    }
    case "shadow": {
      // a device and its offset "shadow" mirror
      let s = "";
      s += `<rect x="${cx - 70}" y="${cy - 70}" width="120" height="150" rx="12" fill="${a}" opacity="0.18"/>`;
      s += `<rect x="${cx - 90}" y="${cy - 90}" width="120" height="150" rx="12" fill="url(#nodeGrad)" stroke="${a}" stroke-width="3"/>`;
      s += `<circle cx="${cx - 30}" cy="${cy - 40}" r="16" fill="none" stroke="${a}" stroke-width="3"/>`;
      s += `<rect x="${cx - 62}" y="${cy}" width="64" height="8" rx="4" fill="${a}" opacity="0.8"/>`;
      s += `<rect x="${cx - 62}" y="${cy + 22}" width="44" height="8" rx="4" fill="${a}" opacity="0.5"/>`;
      // pulse dot = heartbeat / staleness
      s += `<circle cx="${cx - 30}" cy="${cy + 90}" r="7" fill="${a}"><animate attributeName="opacity" values="1;0.2;1" dur="1.4s" repeatCount="indefinite"/></circle>`;
      return s;
    }
    case "stores": {
      // four DB cylinders
      let s = "";
      const pos = [
        [cx - 90, cy - 70],
        [cx + 30, cy - 70],
        [cx - 90, cy + 40],
        [cx + 30, cy + 40],
      ];
      pos.forEach(([x, y], i) => {
        const op = i === 0 ? 1 : 0.55 + i * 0.05;
        s += `<g opacity="${op}"><ellipse cx="${x + 30}" cy="${y}" rx="34" ry="11" fill="${a}"/>`;
        s += `<rect x="${x - 4}" y="${y}" width="68" height="60" fill="url(#nodeGrad)"/>`;
        s += `<rect x="${x - 4}" y="${y}" width="68" height="60" fill="${a}" opacity="0.12"/>`;
        s += `<ellipse cx="${x + 30}" cy="${y + 60}" rx="34" ry="11" fill="url(#nodeGrad)" stroke="${a}" stroke-width="2"/>`;
        s += `<ellipse cx="${x + 30}" cy="${y}" rx="34" ry="11" fill="none" stroke="${a}" stroke-width="2"/></g>`;
      });
      return s;
    }
    case "cluster": {
      // hexagon (k8s-ish) with node cubes
      let s = "";
      const hex = (x, y, r) => {
        let p = "";
        for (let i = 0; i < 6; i++) {
          const ang = (Math.PI / 3) * i - Math.PI / 6;
          p += `${x + r * Math.cos(ang)},${y + r * Math.sin(ang)} `;
        }
        return p.trim();
      };
      s += `<polygon points="${hex(cx, cy, 110)}" fill="none" stroke="${a}" stroke-width="2" opacity="0.35"/>`;
      s += `<polygon points="${hex(cx, cy, 70)}" fill="url(#nodeGrad)" stroke="${a}" stroke-width="3"/>`;
      // helm wheel spokes
      s += node(cx, cy, 22, a);
      for (let i = 0; i < 6; i++) {
        const ang = (Math.PI / 3) * i;
        const x2 = cx + 44 * Math.cos(ang);
        const y2 = cy + 44 * Math.sin(ang);
        s += `<line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" stroke="${a}" stroke-width="4"/>`;
        s += node(x2, y2, 9, a);
      }
      s += node(cx, cy, 10, "#0a0e1a");
      return s;
    }
    case "hmi": {
      // monitor screen with a P&ID-ish flow + gauge
      let s = "";
      s += `<rect x="${cx - 120}" y="${cy - 80}" width="240" height="150" rx="10" fill="url(#nodeGrad)" stroke="${a}" stroke-width="3"/>`;
      s += `<rect x="${cx - 8}" y="${cy + 70}" width="16" height="26" fill="${a}" opacity="0.7"/>`;
      s += `<rect x="${cx - 50}" y="${cy + 96}" width="100" height="10" rx="5" fill="${a}"/>`;
      // pipes + tank
      s += `<circle cx="${cx - 80}" cy="${cy - 20}" r="16" fill="none" stroke="${a}" stroke-width="3"/>`;
      s += `<line x1="${cx - 64}" y1="${cy - 20}" x2="${cx - 20}" y2="${cy - 20}" stroke="${a}" stroke-width="3"/>`;
      s += `<rect x="${cx - 20}" y="${cy - 40}" width="46" height="46" rx="6" fill="none" stroke="${a}" stroke-width="3"/>`;
      s += `<line x1="${cx + 26}" y1="${cy - 20}" x2="${cx + 74}" y2="${cy - 20}" stroke="${a}" stroke-width="3"/>`;
      // gauge arc
      s += `<path d="M ${cx + 58} ${cy - 4} A 22 22 0 1 1 ${cx + 90} ${cy - 4}" fill="none" stroke="${a}" stroke-width="3"/>`;
      s += `<line x1="${cx + 74}" y1="${cy - 20}" x2="${cx + 84}" y2="${cy - 34}" stroke="${a}" stroke-width="3" stroke-linecap="round"/>`;
      // blinking live dot
      s += `<circle cx="${cx + 104}" cy="${cy - 66}" r="6" fill="${a}"><animate attributeName="opacity" values="1;0.2;1" dur="1s" repeatCount="indefinite"/></circle>`;
      return s;
    }
    case "summit": {
      // layered mountain / architecture stack peaking with a flag
      let s = "";
      s += `<polygon points="${cx - 130},${cy + 90} ${cx - 30},${cy - 70} ${cx + 40},${cy + 90}" fill="url(#nodeGrad)" stroke="${a}" stroke-width="3"/>`;
      s += `<polygon points="${cx - 30},${cy + 90} ${cx + 60},${cy - 30} ${cx + 140},${cy + 90}" fill="${a}" opacity="0.25" stroke="${a}" stroke-width="3"/>`;
      s += `<polygon points="${cx - 30},${cy - 70} ${cx - 55},${cy - 34} ${cx - 5},${cy - 34}" fill="${a}"/>`;
      // flag on summit
      s += `<line x1="${cx - 30}" y1="${cy - 70}" x2="${cx - 30}" y2="${cy - 118}" stroke="${a}" stroke-width="3"/>`;
      s += `<polygon points="${cx - 30},${cy - 118} ${cx + 12},${cy - 108} ${cx - 30},${cy - 96}" fill="${a}"/>`;
      return s;
    }
    case "overview": {
      // the whole workshop: edge hex -> flowing pipeline -> cloud store cylinders
      let s = "";
      const ex = cx - 150;
      const sy = cy - 30;
      // edge cluster hex on the left
      const hex = (x, y, r) => {
        let p = "";
        for (let i = 0; i < 6; i++) {
          const ang = (Math.PI / 3) * i - Math.PI / 6;
          p += `${x + r * Math.cos(ang)},${y + r * Math.sin(ang)} `;
        }
        return p.trim();
      };
      s += `<polygon points="${hex(ex, sy, 56)}" fill="url(#nodeGrad)" stroke="${a}" stroke-width="3"/>`;
      s += node(ex, sy, 14, a);
      for (let i = 0; i < 6; i++) {
        const ang = (Math.PI / 3) * i;
        const x2 = ex + 30 * Math.cos(ang);
        const y2 = sy + 30 * Math.sin(ang);
        s += `<line x1="${ex}" y1="${sy}" x2="${x2}" y2="${y2}" stroke="${a}" stroke-width="3"/>`;
        s += node(x2, y2, 6, a);
      }
      s += node(ex, sy, 6, "#0a0e1a");
      s += `<text x="${ex}" y="${sy + 92}" text-anchor="middle" font-size="17" font-weight="700" fill="${a}" opacity="0.85">EDGE</text>`;
      // flowing pipeline across to the cloud
      s += `<line x1="${ex + 60}" y1="${sy}" x2="${cx + 30}" y2="${sy}" stroke="${a}" stroke-width="3" stroke-dasharray="6 6" opacity="0.75"><animate attributeName="stroke-dashoffset" from="24" to="0" dur="1.2s" repeatCount="indefinite"/></line>`;
      // cloud: four store cylinders on the right
      const pos = [
        [cx + 50, sy - 46],
        [cx + 135, sy - 46],
        [cx + 50, sy + 30],
        [cx + 135, sy + 30],
      ];
      pos.forEach(([x, y], i) => {
        const op = i === 0 ? 1 : 0.6 + i * 0.05;
        s += `<g opacity="${op}"><ellipse cx="${x + 24}" cy="${y}" rx="27" ry="9" fill="${a}"/>`;
        s += `<rect x="${x - 3}" y="${y}" width="54" height="46" fill="url(#nodeGrad)"/>`;
        s += `<rect x="${x - 3}" y="${y}" width="54" height="46" fill="${a}" opacity="0.12"/>`;
        s += `<ellipse cx="${x + 24}" cy="${y + 46}" rx="27" ry="9" fill="url(#nodeGrad)" stroke="${a}" stroke-width="2"/>`;
        s += `<ellipse cx="${x + 24}" cy="${y}" rx="27" ry="9" fill="none" stroke="${a}" stroke-width="2"/></g>`;
      });
      s += `<text x="${cx + 133}" y="${sy + 116}" text-anchor="middle" font-size="17" font-weight="700" fill="${a}" opacity="0.85">CLOUD</text>`;
      return s;
    }
    default:
      return "";
  }
}

function svg(s) {
  const a = s.accent;
  const a2 = s.accent2;
  // background circuit dots
  let dots = "";
  for (let y = 40; y < H; y += 46) {
    for (let x = 40; x < 700; x += 46) {
      dots += `<circle cx="${x}" cy="${y}" r="1.4" fill="${a}" opacity="0.06"/>`;
    }
  }
  // edge->cloud baseline pipeline across the bottom
  const flow = `
    <line x1="0" y1="640" x2="1280" y2="640" stroke="${a}" stroke-width="2" opacity="0.25"/>
    <line x1="0" y1="640" x2="1280" y2="640" stroke="${a}" stroke-width="2" stroke-dasharray="4 10" opacity="0.7">
      <animate attributeName="stroke-dashoffset" from="28" to="0" dur="1.6s" repeatCount="indefinite"/>
    </line>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Helvetica Neue',Arial,sans-serif">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0a0e1a"/>
      <stop offset="0.55" stop-color="#0e1526"/>
      <stop offset="1" stop-color="#131c33"/>
    </linearGradient>
    <linearGradient id="accentBar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${a}"/>
      <stop offset="1" stop-color="${a2}"/>
    </linearGradient>
    <linearGradient id="nodeGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1b2740"/>
      <stop offset="1" stop-color="#0d1524"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.75" cy="0.42" r="0.55">
      <stop offset="0" stop-color="${a}" stop-opacity="0.28"/>
      <stop offset="1" stop-color="${a}" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="0.4"/>
    </filter>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <g>${dots}</g>
  ${flow}

  <!-- big translucent session number, background -->
  <text x="1210" y="700" text-anchor="end" font-size="380" font-weight="800"
        fill="${a}" opacity="0.06">0${s.n}</text>

  <!-- accent side bar -->
  <rect x="80" y="150" width="8" height="360" rx="4" fill="url(#accentBar)"/>

  <!-- kicker / brand line -->
  <text x="112" y="118" font-size="20" font-weight="700" letter-spacing="4"
        fill="#7c8aa5">EDGE-TO-CLOUD · DIGITAL OPS WORKSHOP</text>

  <!-- session label -->
  ${s.n === 0
    ? `<text x="112" y="205" font-size="30" font-weight="700" letter-spacing="6" fill="${a}">${esc(s.label)}</text>`
    : `<text x="112" y="205" font-size="30" font-weight="700" letter-spacing="6" fill="${a}">SESSION ${s.n}<tspan fill="#5b6b86">  ·  ${esc(s.kicker)}</tspan></text>`}

  <!-- title -->
  ${titleBlock(s.title)}

  <!-- goal / subtitle -->
  ${goalBlock(s.goal, wrap(s.title, 18).length)}

  <!-- footer meta -->
  ${s.footer
    ? `<text x="112" y="560" font-size="22" font-weight="600" fill="#8fa0bd">${esc(s.footer)} <tspan fill="${a}">·</tspan> hands-on AWS</text>`
    : `<text x="112" y="560" font-size="22" font-weight="600" fill="#8fa0bd">4 hours <tspan fill="${a}">·</tspan> ${s.blocks} <tspan fill="${a}">·</tspan> hands-on AWS</text>`}

  <!-- motif cluster -->
  <g filter="url(#soft)">${motif(s.motif, a, a2)}</g>

  <!-- corner tag -->
  <rect x="1090" y="44" width="140" height="40" rx="20" fill="none" stroke="${a}" stroke-width="2" opacity="0.6"/>
  <text x="1160" y="70" text-anchor="middle" font-size="18" font-weight="700"
        fill="${a}" letter-spacing="2">AWS IoT</text>
</svg>`;
}

// greedy word-wrap to a max character width
function wrap(text, maxChars) {
  const lines = [];
  let cur = "";
  for (const w of text.split(" ")) {
    if ((cur + " " + w).trim().length > maxChars && cur) {
      lines.push(cur.trim());
      cur = w;
    } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

// title wraps onto up to three lines; size shrinks as it grows
function titleBlock(title) {
  const lines = wrap(title, 18);
  const size = lines.length >= 3 ? 58 : lines.length === 2 ? 64 : 74;
  const gap = size + 8;
  const startY = lines.length >= 3 ? 286 : lines.length === 2 ? 300 : 320;
  return lines
    .map(
      (ln, i) =>
        `<text x="110" y="${startY + i * gap}" font-size="${size}" font-weight="800" fill="#f4f7fc">${esc(
          ln
        )}</text>`
    )
    .join("\n  ");
}

// goal sits below the title; start point depends on how many title lines there are
function goalBlock(goal, titleLineCount) {
  const lines = wrap(goal, 52);
  let y = titleLineCount >= 3 ? 462 : titleLineCount === 2 ? 470 : 470;
  return lines
    .map((ln) => {
      const t = `<text x="112" y="${y}" font-size="24" font-weight="400" fill="#aab6cc">${esc(
        ln
      )}</text>`;
      y += 34;
      return t;
    })
    .join("\n  ");
}

for (const s of SESSIONS) {
  const out = join(OUT_DIR, `session-${String(s.n).padStart(2, "0")}-${s.kicker.toLowerCase().replace(/[^a-z]+/g, "-")}.svg`);
  writeFileSync(out, svg(s));
  console.log("wrote", out);
}
console.log(`done — ${SESSIONS.length} covers generated`);
