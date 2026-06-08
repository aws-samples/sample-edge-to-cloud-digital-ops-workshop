# Session 2 — Control: Fleet Management with IoT Jobs

**Duration:** 4 hours  
**Goal:** Use IoT Jobs to push a script update to all 3 devices simultaneously, change telemetry behavior, and experience fleet-level operations at scale.

---

## Session Overview

| Block | Duration | Topic |
|---|---|---|
| [Block 1](block-1-device-client.md) | 45 min | IoT Device Client Architecture |
| [Block 2](block-2-iot-job.md) | 60 min | Create and Deploy an IoT Job |
| [Block 3](block-3-fleet-management.md) | 45 min | Fleet Management Deep Dive |
| [Block 4](block-4-observe.md) | 45 min | Observe the Updated Data Flow |
| Wrap-up | 15 min | Recap + preview Session 3 |

---

## What You Need

- `DEPLOYMENT_ID` from the facilitator
- AWS CLI configured with the workshop IAM role
- The workshop repo cloned locally

---

## What Changes This Session

By the end of Block 2, each device will:

- Publish at **1 Hz** (up from 0.2 Hz)
- Include **`net_io_bytes_sent`** and **`net_io_bytes_recv`** in the telemetry payload
- Report **`config_version: 2.0.0`** in the `device-config` shadow
