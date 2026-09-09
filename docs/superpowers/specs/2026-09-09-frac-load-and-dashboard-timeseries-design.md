# Design — Frac Load Generator + Dashboard Time-Series Panels

**Date:** 2026-09-09
**Status:** Design (awaiting review before implementation plan)
**Author:** Claude + waltmayf

## 1. Goal

Let an operator run a **local** script that generates realistic well-fracturing
telemetry at configurable volume, pushes it into the **cloud MSK** cluster, and
then **watch the data stores behave under that load** on the cloud-analytics
dashboard via three new time-series panels: incoming ingest rate over time,
data-store freshness over time, and query latency over time.

The point is a live A/B demo: ramp the load and watch each store's freshness and
query latency diverge.

## 2. Background / current state

Investigated 2026-09-08/09. Key facts that shape this design:

- A realistic frac generator already exists — `simulator/frac-op-burst.py` /
  `simulator/sensor-sim.py` — but it publishes **MQTT to a local Mosquitto
  broker on the sensor-sim EC2 instance**, not to MSK. There is no
  laptop → MSK producer today.
- The frac ("sensor") payload schema is
  `{sensor, value, unit, ts_ms, site_id}` on MQTT topic
  `sensors/raw/{site_id}/{sensor}`.
- The SCRAM/bootstrap-broker recipe for talking to MSK lives in
  `scripts/create-msk-topics.sh` (SASL_SSL + SCRAM-SHA-512, secret
  `AmazonMSK_workshop-<slot>`, brokers from
  `aws kafka get-bootstrap-brokers … BootstrapBrokerStringSaslScram`), with a
  `kafka-python` fallback.
- The cloud-analytics dashboard is `cloud-dashboard/` (Next.js 15 + React 18 +
  Recharts, in-cluster only, reached via `kubectl port-forward
  svc/cloud-analytics-dashboard`). It shows **current-value bar charts** for
  five tiers (RisingWave, TimescaleDB, Athena/Iceberg, InfluxDB, AppSync).
  **There is no time-over-time / volume chart anywhere.**
- Freshness formula everywhere: `freshness_ms = Date.now() − MAX(latest_ts)`.

### Critical constraint discovered during design

**Only RisingWave, TimescaleDB, and InfluxDB consume MSK topics.**
Athena/Iceberg and AppSync are fed by IoT Rules **directly from MQTT**, not from
MSK. A direct-to-MSK producer therefore moves **3 of the 5 tiers**; Athena and
AppSync stay flat under load. This is accepted and expected (see Non-goals).

Additionally:
- `raw.telemetry` is schema-locked to the host-metrics schema
  (`thing_name`, `cpu_pct`, `mem_used_pct`, `ingest_ts`, `message_timestamp`, …).
  Sending frac payloads there is silently nulled (RisingWave) / dropped
  (InfluxDB).
- `sensors.raw.sim` is schema-matched to the frac payload and **also** reaches
  RisingWave + TimescaleDB + InfluxDB with **zero pipeline changes**, provided
  each `site_id` carries a `ws-slotNN-…` prefix (that is how `deployment_id` is
  derived by the rp-connect TimescaleDB sink's regex and the Telegraf regex
  processor).

## 3. Decisions (locked with user)

| Decision | Choice |
|---|---|
| Ingress mechanism | Local Python producer → direct SCRAM to MSK, network reachability via **sshuttle over SSH-over-SSM** to an EKS node in the cloud VPC. |
| Target topic / schema | **`sensors.raw.sim`**, real frac schema `{sensor, value, unit, ts_ms, site_id}`, `site_id` prefixed `ws-slotNN-…`. |
| Tiers exercised | RisingWave, TimescaleDB, InfluxDB. Athena + AppSync stay flat (accepted). |
| Volume | Configurable via CLI (sites, units/site, Hz, duration) — realistic (~1–5k msg/s) up to stress (10k–50k+). |
| Volume-chart source | New RisingWave MV `mv_fleet_ingest_rate`, **5-second** tumbling window count. |
| Freshness/latency trends | **Client-side ring buffer** (~10 min / ~600 pts) of values already streaming into the dashboard. No server-side history table. |
| Workshop doc | Optional / stretch (documented, not required for "done"). |

## 4. Component A — Local frac → MSK load generator

### 4.1 `simulator/frac-msk-load.py` (new)

- Imports `SENSORS`, `SimulationEngine`, `build_payload` from
  `simulator/sensor-sim.py` (same by-path import trick `frac-op-burst.py`
  already uses) so the payload schema stays identical to today's frac data.
- Produces **directly to MSK** (not MQTT) using `kafka-python`
  `KafkaProducer(security_protocol="SASL_SSL", sasl_mechanism="SCRAM-SHA-512",
  sasl_plain_username/password=…)`, reusing the auth recipe from
  `scripts/create-msk-topics.sh`:
  - creds from Secrets Manager `AmazonMSK_workshop-<slot>`,
  - brokers from `get-bootstrap-brokers … BootstrapBrokerStringSaslScram`.
- Emits JSON `{sensor, value, unit, ts_ms, site_id}` to topic
  `sensors.raw.sim`. **`site_id` = `<slot>-<site>-pump-<n>`** so it always
  starts with the `ws-slotNN` prefix required for `deployment_id` derivation.
- CLI knobs: `--slot` (required), `--sites`, `--units-per-site`, `--hz`,
  `--duration`, `--topic` (default `sensors.raw.sim`), `--region`,
  `--dry-run` (print payloads, no connect).
- Hard-stop watchdog (monotonic deadline + Timer + `os._exit` backstop) and a
  deep outbound queue, mirroring `frac-op-burst.py`'s guarantees.
- Prints a live achieved-rate summary (messages sent, msg/s, duration).

### 4.2 `scripts/msk-tunnel.sh` (new)

- Establishes laptop → private MSK reachability via **`sshuttle`** over
  **SSH-over-SSM** to an EKS node (EC2 in the cloud VPC, runs the SSM agent):
  routes the cloud VPC CIDR (`10.1.0.0/16`) **and DNS** through the tunnel so
  the broker DNS names resolve to private IPs and `kafka-python` connects to
  the real brokers transparently. This is required because a plain
  `AWS-StartPortForwardingSessionToRemoteHost` breaks on multi-broker clusters
  (each broker advertises its own DNS name on 9096; forwarded localhost ports
  collide).
- Discovers a target node, pushes an ephemeral SSH key (EC2 Instance Connect or
  authorized_keys), and starts `sshuttle --dns -r … --ssh-cmd 'ssh -o
  ProxyCommand="aws ssm start-session --target %h --document-name
  AWS-StartSSHSession --parameters portNumber=%p"'`.
- **Documented fallback** (not built unless the tunnel proves brittle): run
  `frac-msk-load.py` as a one-shot `kubectl run` pod in-cluster (repo precedent:
  the e2e topic-creation pod) with native MSK reachability, launched by one
  command from the laptop.

## 5. Component B — Ingest-rate materialized view

### 5.1 `mv_fleet_ingest_rate` (new RisingWave MV)

- Added to the cloud RisingWave DDL (`risingwave/ddl-cloud.sql`; the authoritative
  helm-applied copy to be confirmed during implementation and kept in sync).
- 5-second `TUMBLE` window over the fleet source stream, `COUNT(*)` grouped by
  `deployment_id`, emitting `window_start` (epoch-ms) and `msg_count`. Rate =
  `msg_count / 5`.
- Chosen over the existing (unused) `mv_fleet_1min_avg` because 1-minute
  granularity is too coarse for minute-scale bursts.

### 5.2 `cloud-dashboard/src/app/api/volume/route.ts` (new)

- Reads the last ~10 min of `mv_fleet_ingest_rate` windows for `?did=<slot>`,
  returns `[{ window_start, msg_per_s }]`.
- Polled by the dashboard every few seconds (bursts are minute-scale; SSE not
  needed).

## 6. Component C — Dashboard time-series panels

All in `cloud-dashboard/src/app/page.tsx` + a new hook. Existing snapshot bar
panels are retained.

### 6.1 `useTimeseriesBuffer` (new client hook)

- Bounded ring buffer (~600 points ≈ 10 min). On each freshness/latency tick
  already arriving via the existing SSE/poll paths, appends
  `{ t, rwMs, tsdbMs, athenaMs, influxMs, appsyncMs }` (freshness) and the
  matching latency record; drops the oldest when full.
- No server-side history; buffer lives in the browser tab.

### 6.2 Three new Recharts panels

1. **Ingest Volume (msg/s) over time** — `AreaChart`, single series, from
   `/api/volume`.
2. **Freshness over time** — multi-line (`LineChart`) from the buffer; RW/TSDB/
   InfluxDB move, Athena/AppSync flat. Reuse the existing `Math.log10` tick
   trick for the Y axis.
3. **Query Latency over time** — multi-line from the buffer; same log-scale
   treatment.

- Colours/legend/axes follow the `dataviz` skill + the existing dashboard
  palette (invoke `dataviz` when writing chart code).

## 7. Testing & verification

- **Generator unit-level:** `--dry-run` prints payloads → assert schema shape
  (`sensor, value, unit, ts_ms, site_id`; `site_id` starts `ws-slot`).
- **Smoke:** low-volume real run against a live slot → assert rows land in
  `mv_fleet_ingest_rate` (RisingWave) and `sensor_readings` (TimescaleDB).
- **Dashboard:** extend `e2e/screenshot-dashboard.mjs` (already dumps panel
  text) to confirm the three new panels render and the volume series is
  non-zero during a load run.
- **Manual:** bring up the tunnel, ramp `--hz`, watch volume climb and the
  freshness/latency lines diverge.

## 8. Non-goals

- Making Athena/Iceberg or AppSync reflect the load (they are MQTT-only; out of
  scope).
- Server-side / persistent history of freshness/latency (ring buffer only).
- Any change to `raw.telemetry`'s schema or the real device ingest path.
- Frac-shaped columns in the Iceberg/Glue table or RisingWave `raw.telemetry`
  source (no pipeline schema changes).

## 9. Files touched (summary)

**New:**
- `simulator/frac-msk-load.py`
- `scripts/msk-tunnel.sh`
- `cloud-dashboard/src/app/api/volume/route.ts`
- `cloud-dashboard/src/hooks/useTimeseriesBuffer.ts` (or colocated in page.tsx)

**Modified:**
- `risingwave/ddl-cloud.sql` (+ helm-applied copy, TBC) — add
  `mv_fleet_ingest_rate`.
- `cloud-dashboard/src/app/page.tsx` — three new panels + buffer wiring.
- `e2e/screenshot-dashboard.mjs` — assert new panels.

**Optional / stretch:**
- A `workshop/04-analytics` doc block demonstrating the load + new panels with
  `e2e:assert` annotations.
