# Session 2 — Control: Fleet Management with IoT Jobs

**Duration:** 4 hours  
**Goal:** Use IoT Jobs to push a script update to all 3 devices simultaneously, change telemetry behavior, and experience fleet-level operations at scale.

---

## Session Overview

| Block | Duration | Topic |
|---|---|---|
| [Block 1](block-1-device-client.md) | 45 min | IoT Device Client Architecture |
| [Block 2](block-2-iot-job.md) | 60 min | Create and Deploy an IoT Job |
| [Block 3](block-3-fleet-indexing.md) | 45 min | Fleet Indexing — Query Your Deployment |
| [Block 4](block-4-fleet-management.md) | 45 min | Fleet Management Deep Dive |
| [Block 5](block-5-observe.md) | 45 min | Observe the Updated Data Flow |
| Wrap-up | 15 min | Recap + preview Session 3 |

---

## What You Need

- `DEPLOYMENT_ID` from the facilitator
- AWS CLI configured with the workshop IAM role
- The workshop repo cloned locally

---

## What Changes This Session

By the end of Block 2, each device will:

- Report metric values with **3-decimal-place precision** (`cpu_pct: 12.450` instead of `12`)
- Read its config from the **`device-config` shadow** on startup — telemetry interval and metrics list are no longer hardcoded
- Report **`config_version: 2.0.0`** in the `device-config` shadow, closing the desired/reported delta
