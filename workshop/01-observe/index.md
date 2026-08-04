# Session 1 — Observe: The Data in Motion

**Duration:** 4 hours  
**Goal:** Understand how devices register into IoT Core, then trace the full data path from EC2 → IoT Core → Firehose → S3 → Athena and measure data freshness.

---

## Session Overview

| Block | Duration | Topic |
|---|---|---|
| [Block 0](block-0-fleet-provisioning.md) | 45 min | Fleet Provisioning — how devices got into IoT Core |
| [Block 1](block-1-console-tour.md) | 45 min | Orientation & Console Tour — subscribe to live telemetry |
| [Block 2](block-2-s3.md) | 45 min | S3 Observation — Iceberg files written by Firehose |
| [Block 3](block-3-athena.md) | 60 min | Athena Data Freshness Query |
| Wrap-up | 15 min | Recap + preview Session 2 |

---

## What You Need

- Your `DEPLOYMENT_ID` from the facilitator (format: `ws-a1b2c3`)
- AWS console access with the workshop IAM role assumed

---

## Key Takeaway

By the end of this session you will have measured the **data freshness** of the archive tier (Iceberg/Athena: tens of seconds up to ~300 seconds, governed by Firehose's buffering interval) and understood why it cannot serve a live operational dashboard. This sets up the motivation for the higher-frequency tiers introduced in Sessions 3–4.
