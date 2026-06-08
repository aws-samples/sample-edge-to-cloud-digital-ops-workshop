# Session 3 — State: Device Shadows and the Management UI

**Duration:** 4 hours  
**Goal:** Add the remaining named shadows, use the front-end UI to observe device state, and experience failure detection via shadow staleness.

---

## Session Overview

| Block | Duration | Topic |
|---|---|---|
| [Block 1](block-1-shadows.md) | 45 min | Named Shadow Architecture |
| [Block 2](block-2-shadow-job.md) | 60 min | Deploy Shadow Update Job |
| [Block 3](block-3-ui.md) | 60 min | Front-End UI Walkthrough |
| [Block 4](block-4-failure.md) | 45 min | Failure Detection |
| Wrap-up | 15 min | Recap + preview Session 4 |

---

## Shadow Roadmap

| Shadow Name | Status | Contains |
|---|---|---|
| `device-config` | ✅ Already deployed | Config version, telemetry interval, feature flags |
| `app-deployment` | **Added this session** | Compose version, container image tags, deploy status |
| `device-health` | **Added this session** | CPU/mem/disk %, container count, uptime, last heartbeat |
