# Session 6 — HMI: The Edge Operator Interface

**Duration:** 4 hours  
**Goal:** Use the Next.js HMI via port-forwarding to visualize the industrial site in real time, explore digital ops metrics, and simulate a network failure.

!!! info "Prerequisite"
    Session 5 (K3s cluster + Helm stack) must be complete before starting this session.
    The HMI is deployed as part of the `edge-stack` Helm chart.

---

## Session Overview

| Block | Duration | Topic |
|---|---|---|
| [Block 1](block-1-port-forward.md) | 30 min | Port-Forward and Load the HMI |
| [Block 2](block-2-site-view.md) | 60 min | Site View Exploration |
| [Block 3](block-3-failure-sim.md) | 60 min | Digital Ops Metrics + Network Failure |
| [Block 4](block-4-freshness.md) | 45 min | Compare Edge vs Cloud Freshness |
| Wrap-up | 15 min | Recap |

---

## HMI Pages

| Page | What it shows |
|---|---|
| **Site View** | P&ID-style SVG diagram (React Flow) — live sensor readings on hover |
| **Digital Ops View** | WAN relay lag, edge buffer utilization, queue depth, RisingWave MV freshness |
