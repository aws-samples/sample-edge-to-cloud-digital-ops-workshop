# Session Video Titles & Descriptions

Titles and descriptions for the recorded videos of each workshop session. Cover
images live alongside this file (`session-0N-*.png` / `.svg`).

---

## Overview (Watch First)

**Title:** Edge-to-Cloud Digital Operations: Course Overview

**Subtitle:** What you'll build across seven sessions — and the one tradeoff that ties it all together

**Description:**

Start here. This short overview frames the whole workshop before Session 1: every
pump, compressor, and sensor in the field is already producing data — the value is
in getting the right slice, at the right freshness, to the right person or system,
at a cost that scales. A control-room operator needs sub-second freshness to catch a
failing pump; a reliability engineer needs weeks of trend history; a compliance team
needs an immutable archive going back years. The same sensor reading has to serve all
three. Over seven hands-on sessions you'll build a complete edge-to-cloud pipeline on
AWS — simulated field devices, a cloud ingest and analytics layer, and an edge stack
that keeps running when the network doesn't — then instrument it, break it on purpose,
and watch the same metric arrive through different paths at very different speeds. The
through-line is the freshness-vs-scale efficient frontier: there is no single store
that is both instantly fresh *and* cheap to keep forever, so every session makes one
more point on that frontier observable side by side. By the end you'll be able to look
at any real-time data requirement and answer the questions that drive the architecture:
How fresh? How long retained? What does it cost at fleet scale? What happens when the
network drops?

---

## Session 1 — Observe

**Title:** Observe: Watch Your Sensor Data Move from Edge to Cloud

**Subtitle:** IoT Core → Firehose → S3 → Athena, and your first look at data freshness

**Description:**

Every pump, compressor, and sensor is already generating data — the value is in
getting the right slice to the right place at the right speed. In this opening
session you trace a telemetry reading through its entire journey: simulated field
devices publish over MQTT to AWS IoT Core, an IoT Rule fans the stream to Amazon
Data Firehose, and Firehose lands it as Apache Iceberg files in S3 for Athena to
query. You'll see how fleet provisioning got the devices into IoT Core, subscribe
to live telemetry in the console, inspect the Iceberg files on S3, and run your
first Athena freshness query. The takeaway: the cheap, limitless archive tier
answers in tens of seconds to minutes — and *why* that makes it the wrong tool for
a live operations dashboard, setting up every faster tier that follows.

---

## Session 2 — Control

**Title:** Control: Manage a Whole Fleet with One IoT Job

**Subtitle:** Push a live behavior change to every device at once — and query the fleet

**Description:**

Observing data is only half the story; operating the fleet is the other half. In
this session you use AWS IoT Jobs to push a script update to all three devices
simultaneously and change their telemetry behavior on the fly — higher-precision
metrics, config read from a device shadow instead of hardcoded values, and a
version bump that closes the desired/reported delta. You'll dig into the IoT Device
Client architecture, create and deploy a Job, then use Fleet Indexing to query the
state of your entire deployment with a single search. By the end you've experienced
fleet-level operations the way a real digital-ops team runs them — changing many
devices at once and confirming the result across the fleet.

---

## Session 3 — State

**Title:** State: Device Shadows and Catching Failures Before They Hurt

**Subtitle:** Named shadows for config, deployment, and health — plus failure detection via staleness

**Description:**

A device's *reported state* is where fleet management gets real. This session adds
the remaining named shadows — `app-deployment` (compose version, image tags, deploy
status) and `device-health` (CPU/mem/disk, container count, uptime, last heartbeat)
— on top of the `device-config` shadow from Session 2. You'll deploy a shadow-update
Job, watch the desired/reported reconciliation happen, then deliberately break a
device and detect the failure through shadow staleness. The lesson: shadows aren't
just a config channel, they're an always-current mirror of the fleet you can alarm
on when a device goes quiet.

---

## Session 4 — Analytics

**Title:** Analytics: Four Data Stores, One Metric, Side by Side

**Subtitle:** RisingWave, TimescaleDB, Timestream for InfluxDB, and Iceberg/Athena — live freshness compared

**Description:**

There is no single store that is both instantly fresh *and* cheap to keep forever.
This session makes that trade-off visible: the same pump-rate telemetry flows into
four different stores and you watch each one's freshness and query latency live on
a single dashboard. You'll build in-memory streaming materialized views in
RisingWave, compare data-delivery patterns (live WebSocket push via AppSync as a
clock signal vs. on-demand SQL), set up TimescaleDB continuous aggregates, and stand
up Timestream for InfluxDB as a managed hot tier — then see all four ranged along
the freshness ladder from ~10 ms live push to ~300 s Iceberg archive. This is the
first session you drive from your own laptop against the shared EKS cluster
(kubectl, helm, psql, aws CLI). The core skill: knowing which store answers which
question — and being able to prove it rather than take it on faith.

---

## Session 5 — Edge Infrastructure

**Title:** Edge Infrastructure: Build a Full Data Pipeline That Runs Off-Grid

**Subtitle:** Deploy a K3s cluster via IoT Job, then a complete edge stack with Helm

**Description:**

Remote sites lose their network — and operations can't stop when they do. In this
session you bootstrap a K3s Kubernetes cluster across three edge EC2 instances using
an IoT Job, then deploy the entire edge data pipeline with Helm: Redpanda (3-node
Raft) as a durable offline buffer, Redpanda Connect bridging MQTT in, edge RisingWave
for streaming materialized views, TimescaleDB (CloudNativePG) as the local system of
record, MinIO for checkpoints and tiered storage, and the Next.js HMI. You'll launch
the K3s Job and sensor EC2 in parallel, verify the edge pipeline end to end, and set
up cluster observability with Prometheus, Grafana, and k9s. The result is a
self-contained edge that keeps running — and keeps its data — independent of the
cloud.

---

## Session 6 — HMI

**Title:** HMI: The Control-Room View — and Surviving a Network Outage

**Subtitle:** A live P&ID site view, digital-ops metrics, and a deliberate WAN failure

**Description:**

This is what the operator actually sees. Using port-forwarding into the edge
cluster, you load the Next.js HMI and explore a P&ID-style industrial site diagram
with live sensor readings on hover, then move to the Digital Ops view showing WAN
relay lag, edge buffer utilization, queue depth, and RisingWave MV freshness. The
centerpiece: you cut the network on purpose, watch local operations keep running
with zero data loss while the edge buffers everything, and see the backlog reconcile
automatically when the link returns. You'll finish by comparing edge vs. cloud
freshness of the same metric — the payoff of everything built in Sessions 1–5.

---

## Session 7 — Capstone

**Title:** Capstone: From Workshop to Production Edge Operations

**Subtitle:** Full architecture review, fleet-scale economics, Day-2 operations, and teardown

**Description:**

In the final session you step back from the keyboard and connect what you built to
a real-world deployment. You'll walk the full edge-to-cloud architecture end to end
— including how to choose your AWS entry point (IoT Core vs. MSK vs. an edge Redpanda
relay) per device — then discuss what changes at fleet scale: cost at thousands of
devices, where each freshness tier earns its place, and where the bill comes from. A
Day-2 operations scenario tests how you'd run, monitor, and recover this pipeline in
production, and the session closes with a clean teardown plus open Q&A and PoC
scoping. Leave able to look at any real-time data requirement and answer the
questions that drive the architecture: How fresh? How long retained? What does it
cost at scale? What happens when the network drops?
