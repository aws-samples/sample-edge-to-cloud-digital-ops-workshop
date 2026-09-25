# Data-store comparison — measurement harness

Runnable scripts for the experiment specified in
[`../2026-09-25-fair-datastore-comparison-spec.md`](../2026-09-25-fair-datastore-comparison-spec.md).
Read the spec first — it defines *what* is being measured and *why*. This README is
the *how to run it* companion.

## Files

| File | Role |
|---|---|
| `frac-runner.py` | In-pod wrapper around `simulator/frac-msk-load.py`. Runs on each load pod, connects to MSK from env creds, produces frac telemetry straight to `sensors.raw.sim`. Slot-agnostic (`--slot`). |
| `measure-freshness.py` | Drives the load ramp from your laptop and samples store freshness per rung. **Parameterized** by `--slot` / `--namespace` / `--pg-pod`. |

> **Scope caveat.** `measure-freshness.py` as committed measures the **TimescaleDB**
> freshness/CAGG path only — the same code that produced the current (TSDB) blog numbers,
> just parameterized. The *full fair harness* (RisingWave MV + InfluxDB freshness, the Q4
> analytical aggregation with latency **and** returned value, and the per-hop decomposition)
> is specified in the spec §5–§6 and is **not yet implemented** here. `Harness.sample()`
> carries an `EXTEND HERE` marker showing exactly where to add the other stores so all four
> are read in the same sampling window. Do the infra changes in spec §4 before wiring per-hop.

## Prerequisites

- `kubectl` context on the workshop EKS cluster.
- Load pods `frac-load-big`, `frac-load-big2` … `frac-load-big6` present in the target
  namespace, each with the MSK creds secret mounted as env
  (`MSK_BOOTSTRAP_SERVERS` / `MSK_USERNAME` / `MSK_PASSWORD`).
- `python3` locally (stdlib only — no pip installs needed for the harness itself).

## Deploy the runner to the load pods

`frac-runner.py` imports the generator from `/tmp/frac-msk-load.py`, so copy **both** files
into each pod (adjust namespace to your slot):

```bash
NS=ws-slot42
for pod in frac-load-big frac-load-big2 frac-load-big3 frac-load-big4 frac-load-big5 frac-load-big6; do
  kubectl cp simulator/frac-msk-load.py            "$NS/$pod:/tmp/frac-msk-load.py"
  kubectl cp docs/experiments/harness/frac-runner.py "$NS/$pod:/tmp/frac-runner.py"
done
```

(Run from the repo root so the relative paths resolve.) If the `frac-load-big*` pods don't
exist, create them from `simulator/` — a bare pod with the `python:3.12-slim` image, the
`msk-credentials` secret as env, and `kafka-python` installed is enough; see spec §11.

## Run the ramp

```bash
# Full 6-rung ramp against ws-slot42 (namespace defaults to the slot name):
python3 docs/experiments/harness/measure-freshness.py --slot ws-slot42 --out /tmp/fresh.json

# 3-rung CAGG control (the one that confirmed the grid-alignment fix):
python3 docs/experiments/harness/measure-freshness.py --slot ws-slot42 --rungs cagg --out /tmp/cagg.json

# Different namespace / primary pod name:
python3 docs/experiments/harness/measure-freshness.py --slot ws-slot07 --namespace ws-slot07 --pg-pod timescaledb-cloud-1
```

Each rung: launch load on N pods → warm up 70 s → sample every 5 s for 75 s → record
median/min/max/p95. The full ramp takes ~25–35 min. Results stream to stdout and are written
(incrementally, so a mid-run abort still leaves partial data) to `--out`.

## Timestamp origin

`ts_ms` is stamped at generation time in `simulator/sensor-sim.py` (`build_payload`),
immediately before the producer send in `simulator/frac-msk-load.py`
(`producer.send('sensors.raw.sim', …)`). Because the frac generator produces **straight to
MSK**, the measured "end-to-end freshness" is the **store ingest tail** (MSK-produce →
queryable), *not* a field device's device→MQTT→IoT-Core→Rule→landing path. State this scope
in any write-up (see spec §9, footnote ⁂).
