---
hide:
  - navigation
  - toc
---

# Edge Digital Operations Workshop

**Turn the data your equipment already produces into decisions you can act on in seconds — not next quarter.**

Every pump, compressor, and sensor in the field is already generating a stream of readings. The business value isn't in *collecting* that data — it's in getting the right slice of it, at the right freshness, to the right person or system, at a cost that scales. A control-room operator needs sub-second freshness to catch a failing pump. A reliability engineer needs weeks of trend history. A compliance team needs an immutable archive going back years. **The same sensor reading has to serve all three — and each has a different tolerance for latency, cost, and complexity.**

This workshop is a hands-on tour of how to build that pipeline on AWS, end to end, and — just as importantly — how to make the architectural tradeoffs that decide whether it delivers business value or becomes an expensive science project.

---

## Why This Matters to the Business

- **Faster decisions → less downtime.** Catching a pump-rate anomaly in 80 milliseconds instead of 5 minutes is the difference between a graceful shutdown and an unplanned outage. We make that latency *visible and measurable* so you can put a number on it.
- **Right-sized cost.** Keeping every reading in a live in-memory store is fast but expensive; archiving everything to cheap object storage is affordable but slow to query. Most real value comes from knowing *which tier serves which question* — and this workshop makes you choose, and shows you the bill.
- **Resilience where connectivity is unreliable.** Remote sites lose their network. We show how to keep local operations running — and lose zero data — through a WAN outage, then reconcile automatically when the link returns.
- **Avoiding lock-in.** The pipeline is built from managed AWS services *and* open, portable components, so you can see exactly where each tradeoff between "fully managed and fast" and "open and portable" lands.

By the end you'll be able to look at a real-time data requirement and answer the questions that actually drive the architecture: *How fresh does this need to be? How long must we keep it? What does it cost at fleet scale? What happens when the network drops?*

---

## The Core Tradeoff: Freshness vs. Scale

There is no single store that is both instantly fresh *and* cheap to keep forever at unlimited volume. The fresh-**and**-limitless corner is an *unattainable ideal* — so every real option lands on an **efficient frontier**, where you can only buy more of one axis by giving up the other. No point on that frontier beats the others; each is the best choice for a *different* question.

<div style="max-width:780px;margin:1.5rem auto;">
<svg viewBox="0 0 820 500" role="img" aria-labelledby="pareto-title pareto-desc" style="width:100%;height:auto;font-family:var(--md-text-font-family,sans-serif);">
  <title id="pareto-title">Data freshness vs. data-volume scalability — an efficient frontier</title>
  <desc id="pareto-desc">A scatter plot whose vertical axis is data freshness (fresh at top) and horizontal axis is data volume and retention (high at right). Five data stores sit on a downward-sloping efficient frontier: live push via AppSync is freshest but stores nothing; RisingWave in-memory is very fresh with limited volume; TimescaleDB (self-managed, continuous aggregates) is the fresher disk hot tier while managed Timestream for InfluxDB trades a little freshness for higher write volume and retention; Iceberg on S3 via Athena holds unlimited history but is the slowest to query. The top-right corner — fresh at unlimited scale — is marked as an unattainable ideal.</desc>

  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="var(--md-default-fg-color--light)"/>
    </marker>
  </defs>

  <!-- attainable region (everything below/left of the frontier) -->
  <path d="M110,81 L143,81 L268,112 L407,203 L493,228 L737,385 L737,420 L110,420 Z"
        fill="var(--md-primary-fg-color)" fill-opacity="0.06" stroke="none"/>

  <!-- axes -->
  <line x1="110" y1="420" x2="770" y2="420" stroke="var(--md-default-fg-color--light)" stroke-width="1.5" marker-end="url(#arrow)"/>
  <line x1="110" y1="420" x2="110" y2="60"  stroke="var(--md-default-fg-color--light)" stroke-width="1.5" marker-end="url(#arrow)"/>

  <!-- axis titles -->
  <text x="440" y="468" text-anchor="middle" font-size="15" font-weight="600" fill="var(--md-default-fg-color)">Data volume &amp; retention &#8594;</text>
  <text x="42"  y="245" text-anchor="middle" font-size="15" font-weight="600" fill="var(--md-default-fg-color)" transform="rotate(-90 42 245)">Data freshness &#8594;</text>
  <text x="120" y="438" font-size="12" fill="var(--md-default-fg-color--light)">low</text>
  <text x="760" y="438" text-anchor="end" font-size="12" fill="var(--md-default-fg-color--light)">high</text>
  <text x="100" y="78"  text-anchor="end" font-size="12" fill="var(--md-default-fg-color--light)">fresh</text>
  <text x="100" y="418" text-anchor="end" font-size="12" fill="var(--md-default-fg-color--light)">slow</text>

  <!-- unattainable ideal corner -->
  <circle cx="740" cy="84" r="9" fill="none" stroke="var(--md-default-fg-color--light)" stroke-width="1.5" stroke-dasharray="3 3"/>
  <text x="726" y="88" text-anchor="end" font-size="12.5" font-style="italic" fill="var(--md-default-fg-color--light)">Ideal: fresh at any volume</text>
  <text x="726" y="104" text-anchor="end" font-size="12.5" font-style="italic" fill="var(--md-default-fg-color--light)">&#8212; unattainable</text>

  <!-- efficient frontier -->
  <polyline points="143,81 268,112 407,203 493,228 737,385" fill="none"
            stroke="var(--md-primary-fg-color)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>

  <!-- points (2px surface ring so they sit on the line) -->
  <g fill="var(--md-primary-fg-color)" stroke="var(--md-default-bg-color)" stroke-width="2.5">
    <circle cx="143" cy="81"  r="7"/>
    <circle cx="268" cy="112" r="7"/>
    <circle cx="407" cy="203" r="7"/>
    <circle cx="493" cy="228" r="7"/>
    <circle cx="737" cy="385" r="7"/>
  </g>

  <!-- point labels -->
  <g font-size="13.5" fill="var(--md-default-fg-color)">
    <text x="156" y="85"  font-weight="600">Live push (AppSync)</text>
    <text x="281" y="116" font-weight="600">RisingWave — in-memory</text>
    <text x="399" y="222" text-anchor="end" font-weight="600">TimescaleDB</text>
    <text x="506" y="225" font-weight="600">Timestream for InfluxDB</text>
    <text x="726" y="380" text-anchor="end" font-weight="600">Iceberg on S3 / Athena</text>
  </g>
</svg>
</div>

Read it as a menu, not a ranking. **Live push** and **in-memory** stores (top-left) give millisecond freshness for the *current* picture but retain little history. **Object storage** (bottom-right) keeps everything cheaply for years but answers in seconds-to-minutes. The **disk-based hot tiers** sit between them, balancing recent history against query speed. The business skill is knowing which question sits where on this frontier — and this workshop makes every one of these tiers observable side by side, so you can *see* the trade-off rather than take it on faith.

---

## What You'll Build

Over seven sessions you'll stand up a complete edge-to-cloud pipeline: simulated field devices publishing telemetry, a cloud ingest and analytics layer, and an edge stack that keeps running when the network doesn't. You'll instrument it, break it on purpose, and watch the same metric arrive through different paths at very different speeds — the core lesson of the whole workshop.

The deep technical detail — the layered mental model, the full architecture diagram, and the freshness/cost comparison tables — lives in the [Architecture Reference](reference/architecture.md) and in the individual sessions, so we can keep this overview focused on the *why*.

---

## Session Map

| # | Session | Goal |
|---|---------|------|
| Pre | [Admin Setup](00-prerequisites/index.md) | Deploy the platform stack |
| 1 | [Observe — The Data in Motion](01-observe/index.md) | IoT Core → Firehose → S3 → Athena |
| 2 | [Control — Fleet Management](02-control/index.md) | IoT Jobs, device update, fleet indexing |
| 3 | [State — Device Shadows & UI](03-state/index.md) | Named shadows, Amplify front end, failure detection |
| 4 | [Analytics — Cloud Telemetry](04-analytics/index.md) | RisingWave MVs, TimescaleDB CAGGs, freshness comparison |
| 5 | [Edge Infrastructure — K3s](05-edge-infra/index.md) | K3s cluster via IoT Job, Helm edge stack |
| 6 | [HMI — Edge Operator Interface](06-hmi/index.md) | P&ID site view, Digital Ops metrics, network failure |
| 7 | [Capstone — Production Path](07-capstone/index.md) | Architecture review, fleet scale, Day-2 ops, teardown |

---

## Before You Begin

Check that you have received your **`DEPLOYMENT_ID`** (format: `ws-a1b2c3`) from the workshop facilitator. You will substitute this value wherever you see `ws-slot00` in the instructions.
