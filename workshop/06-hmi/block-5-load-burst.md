# Block 5 — Realistic Data Volume Burst

**Duration:** 30 min

---

## Goal

You've compared edge and cloud freshness at the workshop's calm 3-device
baseline ([Block 4](block-4-freshness.md)). Now drive a **realistic
well-fracturing data volume** through the *same* pipeline for **exactly five
minutes**, with both dashboards open, and watch how each data store
(TimescaleDB, RisingWave, Athena/Iceberg) behaves under sustained heavy load —
then self-terminates and drains back to baseline.

The burst uses the **same MQTT topic and payload schema** as the steady-state
`sensor-sim.py` — same field names, same units, same `sensors/raw/<site>/<sensor>`
topics — so nothing downstream has to change. It just runs many simulated pumping
units at a far higher per-sensor sample rate than the ~1 Hz baseline.

---

## Load profile

| Parameter | Default | Meaning |
|---|---|---|
| `--devices` | `10` | simulated pumping units / frac-spread data channels |
| `--hz` | `10` | samples/second **per sensor** (baseline sim is ~1 Hz) |
| sensors/device | `9` | inherited from `sensor-sim.py`'s `SENSORS` list |
| `--duration` | `300` | burst length in seconds — **5 minutes, then a hard stop** |

`10 devices × 9 sensors × 10 Hz ≈ **900 messages/second** sustained`, roughly
**270,000 messages** over the five-minute stage — about **900× the baseline
message rate** the pipeline normally carries. Real frac-spread data-acquisition
vans sample pressure and rate channels well above 1 Hz across a whole fleet of
pumping units, so ~900 msg/s is a defensible stand-in for a busy multi-pump
stage while staying friendly to the single edge Mosquitto broker. A stage ramp
is overlaid on proppant concentration and slurry flow so the values climb like a
real fracturing stage building — without touching the payload schema.

Bump `--devices` / `--hz` for a heavier stress test (e.g. `--devices 20 --hz 20`
≈ 3,600 msg/s). The generator prints its target rate on startup and a summary
(messages sent, achieved rate, duration) on exit.

??? example "View source — burst load profile (`simulator/frac-op-burst.py`)"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/simulator/frac-op-burst.py){ .md-button target=_blank }

    ```python
    --8<-- "simulator/frac-op-burst.py:profile"
    ```

??? example "View source — the fixed-duration burst loop (hard 5-minute stop)"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/simulator/frac-op-burst.py){ .md-button target=_blank }

    ```python
    --8<-- "simulator/frac-op-burst.py:burst-loop"
    ```

    The 5-minute stop is guaranteed three ways — the loop's own monotonic
    deadline check, a watchdog `Timer` that flips the stop flag at the deadline,
    and a last-resort `Timer` that force-exits a few seconds past it — so the
    burst is a **hard stop, not best-effort**, even if the broker back-pressures.

---

## Step 1 — Open both dashboards

Keep both open side by side for the whole five minutes so you can watch the
freshness numbers move together.

**Edge HMI** (from [Block 1](block-1-port-forward.md)):

```bash
kubectl port-forward -n edge svc/edge-stack-hmi 3000:3000 > /tmp/hmi-burst-pf.log 2>&1 &
HMI_PF_PID=$!
until grep -q "Forwarding from" /tmp/hmi-burst-pf.log 2>/dev/null; do sleep 1; done
curl -sf http://localhost:3000 | head -c 200
```
<!-- e2e:assert {"contains": "<"} -->

**Cloud dashboard** (the freshness-comparison panel from
[Session 4, Block 5](../04-analytics/block-5-dashboard.md)):

```bash
kubectl port-forward -n ws-slot00 svc/cloud-analytics-dashboard 3001:3000 > /tmp/dash-burst-pf.log 2>&1 &
DASH_PF_PID=$!
until grep -q "Forwarding from" /tmp/dash-burst-pf.log 2>/dev/null; do sleep 1; done
curl -sf http://localhost:3001 | head -c 200
```
<!-- e2e:assert {"contains": "<"} -->

Leave both port-forwards running and open `http://localhost:3000` (edge) and
`http://localhost:3001` (cloud) in two browser tabs.

---

## Step 2 — Fire the 5-minute burst

The burst publishes to the **edge Mosquitto broker on the sensor-sim EC2
instance** — the same broker `sensor-sim.py` already uses — so the burst joins
the existing ingest path with no config changes. Run it *on* that instance via
`aws ssm send-command`; the burst script was uploaded to the shared S3 bucket
next to `sensor-sim.py` at deploy time.

```bash
SIM_INSTANCE=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=workshop-ws-slot00-sensor-sim" \
            "Name=instance-state-name,Values=running" \
  --query "Reservations[0].Instances[0].InstanceId" --output text)

SHARED_BUCKET=$(aws cloudformation list-exports \
  --query "Exports[?Name=='workshop-platform-bucket-name'].Value" --output text)

# Fetch the burst generator and run a 5-minute frac-op burst against the local
# Mosquitto broker. --duration 300 self-terminates after exactly 5 minutes.
CMD_ID=$(aws ssm send-command \
  --instance-ids "$SIM_INSTANCE" \
  --document-name "AWS-RunShellScript" \
  --timeout-seconds 600 \
  --parameters "commands=[\"aws s3 cp s3://${SHARED_BUCKET}/simulator/frac-op-burst.py /usr/local/bin/frac-op-burst.py\", \"python3 /usr/local/bin/frac-op-burst.py --host localhost --port 1883 --devices 10 --hz 10 --duration 300\"]" \
  --query "Command.CommandId" --output text)
echo "burst command: $CMD_ID"
```
<!-- e2e:assert {"notContains": "None"} -->

The `send-command` returns immediately; the burst then runs on the instance for
five minutes. Watch the dashboards **now** — this is the window where the data
stores diverge.

---

## Step 3 — Watch each store under load

The [freshness table in Block 4](block-4-freshness.md#freshness-comparison-table)
and the [live cloud dashboard](../04-analytics/block-5-dashboard.md) are your
instruments. What to look for while the burst runs:

| Store | What to watch | Why |
|---|---|---|
| **Edge HMI (RisingWave MV)** | Does freshness stay sub-second, or climb into seconds? | RisingWave does aggregation **at write time**; sustained high ingest can push the checkpoint-commit path behind (see the [worked checkpoint example](../04-analytics/block-5-dashboard.md#data-store-performance-characteristics)). A **stale-but-fast-to-read** tier is the signature. |
| **Cloud TimescaleDB CAGG** | Freshness and the "time since last message" chart | Rows arrive via Redpanda Connect's batch window + MSK; watch for ingestion lag as the row rate jumps ~900×. The windowed read stays fast; freshness is the metric that moves. |
| **Cloud RisingWave panel** | Same freshness metric over the WAN | Compare edge vs cloud RisingWave under identical load — the WAN relay + cloud MSK hop adds propagation delay. |
| **Athena / Iceberg tile** | Freshness stays tens-of-seconds regardless | Firehose buffers to S3 (128 MB or 300 s). A burst fills the buffer *faster*, so a flush may fire on the size threshold sooner than the 300 s timer — but it's still a batch/reporting tier, never live. |

Key idea to confirm with your own eyes: **freshness and query latency move
independently.** Under the burst a live tier can show seconds-old data while
still *answering* in milliseconds — that's an **ingestion** signal, not a slow
read path. If **every** tier goes stale together, the upstream (broker / MSK) is
the bottleneck; if **one** tier drifts while the others stay current, that store's
own write/commit path is the constraint.

---

## Step 4 — Confirm the burst self-terminated and drained

After five minutes the burst stops on its own. Read its exit summary — messages
sent, achieved rate, duration:

```bash
aws ssm get-command-invocation \
  --command-id "$CMD_ID" --instance-id "$SIM_INSTANCE" \
  --query "StandardOutputContent" --output text | tail -n 12
```
<!-- e2e:assert {"contains": "SUMMARY"} -->

You should see a `SUMMARY` block reporting roughly `900 msg/s` achieved over
`300 s`. On the dashboards, watch each tier's freshness recover toward its
baseline now that the flood has stopped — the order in which they recover is as
instructive as the order in which they fell behind.

Clean up the port-forwards:

```bash
kill "$HMI_PF_PID" "$DASH_PF_PID" 2>/dev/null || true
```

!!! note "The baseline `sensor-sim.py` keeps running throughout"
    The burst is additive — it publishes alongside the always-on 3-device
    simulator, using the same topics and schema. Nothing needs to be stopped or
    restarted before or after; once the burst self-terminates, only the baseline
    traffic remains.

---

## Discussion

- Which store degraded **freshness** first under the burst, and which held its
  latency budget? Map that back to the write-time vs read-time split from the
  [performance-characteristics section](../04-analytics/block-5-dashboard.md#data-store-performance-characteristics).
- At `--devices 20 --hz 20` (~3,600 msg/s), which tier breaks the customer's
  **2-second end-to-end budget** first?
- A real stage is minutes of sustained pumping, not a spike. Which store would
  you put the **live frac-control panel** on, and which is for **post-stage
  analysis**?
