#!/usr/bin/env python3
"""
Frac-op telemetry BURST generator.

Fires a realistic, high-volume well-fracturing (frac-op) telemetry burst for a
FIXED duration (default 5 minutes) then self-terminates hard, so a workshop
participant can watch how each data store (TimescaleDB, RisingWave,
Athena/Iceberg) behaves under heavy sustained load and then see the pipeline
drain back to baseline.

This does NOT invent a new telemetry schema. It reuses the exact MQTT topic
shape, payload schema, field names, units and correlated sensor model from
``sensor-sim.py`` — it just runs MANY simulated pumping units at a MUCH higher
per-sensor sample rate than the steady-state 0.2–1 Hz baseline.

Load profile (defaults):
  * ``--devices 10``  simulated pumping units / frac-spread data channels
  * ``--hz 10``       samples per second per sensor (baseline sim is ~1 Hz)
  * 9 sensors per device (inherited from sensor-sim.py's SENSORS list)
  => 10 devices x 9 sensors x 10 Hz = ~900 messages/second sustained,
     ~270,000 messages over a 5-minute stage.
Real frac-spread data-acquisition vans sample pressure/rate channels well above
1 Hz across a whole fleet of pumping units; 900 msg/s is a defensible stand-in
for a busy multi-pump stage while staying friendly to a single Mosquitto broker.

A stage ramp is overlaid on proppant concentration and slurry flow so the burst
looks like a real fracturing stage ramping up — WITHOUT changing the payload
schema (same fields, same units).

Config (env vars, same names as sensor-sim.py; CLI flags override):
  MQTT_HOST  - broker hostname (default: localhost)
  MQTT_PORT  - broker port     (default: 1883)
  SITE_ID    - used as the site-id prefix (default: frac-fleet)

Usage:
  python frac-op-burst.py                          # 5-minute burst, defaults
  python frac-op-burst.py --devices 20 --hz 20     # heavier: ~3,600 msg/s
  python frac-op-burst.py --duration 60            # short 1-minute smoke test
  python frac-op-burst.py --host 10.0.1.23         # point at the sensor-sim broker
"""

import argparse
import importlib.util
import os
import signal
import sys
import threading
import time
from pathlib import Path

import paho.mqtt.client as mqtt

# ---------------------------------------------------------------------------
# Reuse the telemetry schema + correlated sensor model from sensor-sim.py.
# The filename is hyphenated (not an importable module name), so load it by
# path. Importing is side-effect-free: sensor-sim.py only connects to MQTT
# inside its own `if __name__ == "__main__"` guard, not at import time.
# ---------------------------------------------------------------------------
_SIM_PATH = Path(__file__).with_name("sensor-sim.py")
_spec = importlib.util.spec_from_file_location("sensor_sim", _SIM_PATH)
sensor_sim = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sensor_sim)

SENSORS = sensor_sim.SENSORS
SimulationEngine = sensor_sim.SimulationEngine
build_topic = sensor_sim.build_topic
build_payload = sensor_sim.build_payload

# --8<-- [start:profile]
# ---------------------------------------------------------------------------
# Burst load profile — defaults chosen to represent a busy multi-pump frac
# stage while staying kind to a single Mosquitto broker. All are CLI-tunable.
# ---------------------------------------------------------------------------
DEFAULT_DEVICES = 10        # simulated pumping units / frac-spread data channels
DEFAULT_HZ = 10.0           # samples/second PER SENSOR (baseline sim is ~1 Hz)
DEFAULT_DURATION_S = 300    # 5-minute stage, then hard self-terminate
# => DEFAULT_DEVICES * len(SENSORS) * DEFAULT_HZ  ~= 900 messages/second
# --8<-- [end:profile]


def _apply_stage_ramp(readings: dict, progress: float) -> dict:
    """Overlay a fracturing-stage ramp on top of the correlated base readings.

    A real stage ramps proppant concentration (and, with it, slurry flow) up as
    it progresses. We scale those two channels by stage ``progress`` (0.0 -> 1.0)
    so the burst looks like a live stage ramp. Schema is untouched — same field
    names, same units, only the value moves.
    """
    ramp = 0.15 + 0.85 * progress  # start at 15% of value, climb to 100%
    if "proppant_conc_lb_gal" in readings:
        readings["proppant_conc_lb_gal"] *= ramp
    if "slurry_flow_bpm" in readings:
        # Flow climbs from ~55% to full as the stage builds.
        readings["slurry_flow_bpm"] *= (0.55 + 0.45 * progress)
    return readings


# --8<-- [start:burst-loop]
def run_burst(client: mqtt.Client, engines: list, args) -> dict:
    """Publish every sensor for every device at ``args.hz`` for ``args.duration``
    seconds, then stop hard. Returns a summary dict.

    Termination is guaranteed by three independent mechanisms so the 5-minute
    stop is a hard stop, not best-effort:
      1. the loop's own monotonic deadline check (primary),
      2. a watchdog Timer that flips the stop flag at the deadline, and
      3. a last-resort Timer that force-exits a few seconds past the deadline.
    """
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())

    start = time.monotonic()
    deadline = start + args.duration
    tick_interval = 1.0 / args.hz
    n_sensors = len(SENSORS)
    sent = 0
    ticks = 0

    # (2) watchdog: flip the stop flag exactly at the deadline.
    threading.Timer(args.duration, stop.set).start()
    # (3) hard backstop: if the loop somehow overruns, force the process down.
    hard = threading.Timer(args.duration + 5.0, lambda: os._exit(0))
    hard.daemon = True
    hard.start()

    print(
        f"[burst] START — devices={len(engines)} hz={args.hz} "
        f"sensors/device={n_sensors} target={len(engines) * n_sensors * args.hz:.0f} msg/s "
        f"duration={args.duration}s broker={args.host}:{args.port}",
        flush=True,
    )

    next_tick = start
    while not stop.is_set():
        now = time.monotonic()
        if now >= deadline:
            break
        progress = min(1.0, (now - start) / args.duration)

        for idx, engine in enumerate(engines):
            site_id = f"{args.site_prefix}-{idx:02d}"
            readings = _apply_stage_ramp(engine.read_all(), progress)
            for name, unit, _interval, _lo, _hi in SENSORS:
                topic = build_topic(site_id, name)
                payload = build_payload(name, readings[name], unit, site_id)
                client.publish(topic, payload, qos=0)
                sent += 1
        ticks += 1

        if ticks % int(max(1, args.hz)) == 0:  # ~once/second progress line
            elapsed = now - start
            rate = sent / elapsed if elapsed > 0 else 0.0
            print(
                f"[burst] t={elapsed:6.1f}s  sent={sent:>9}  "
                f"rate={rate:8.1f} msg/s  stage={progress * 100:5.1f}%",
                flush=True,
            )

        # Fixed-rate pacing: sleep until the next scheduled tick, never negative.
        next_tick += tick_interval
        sleep_for = next_tick - time.monotonic()
        if sleep_for > 0:
            stop.wait(sleep_for)

    hard.cancel()
    elapsed = time.monotonic() - start
    return {
        "messages_sent": sent,
        "ticks": ticks,
        "duration_s": round(elapsed, 2),
        "achieved_rate_msg_s": round(sent / elapsed, 1) if elapsed > 0 else 0.0,
        "devices": len(engines),
        "sensors_per_device": n_sensors,
    }
# --8<-- [end:burst-loop]


def connect_mqtt(host: str, port: int, site_prefix: str) -> mqtt.Client:
    client = mqtt.Client(client_id=f"frac-op-burst-{site_prefix}", clean_session=True)

    def on_connect(c, userdata, flags, rc):
        if rc == 0:
            print(f"[mqtt] connected to {host}:{port}", flush=True)
        else:
            print(f"[mqtt] connection failed, rc={rc}", flush=True)

    client.on_connect = on_connect
    # Deep outbound queue — a burst pushes far more than paho's default 20.
    client.max_inflight_messages_set(1000)
    client.max_queued_messages_set(0)  # 0 = unlimited
    client.connect(host, port, keepalive=60)
    client.loop_start()
    return client


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Realistic frac-op telemetry BURST (fixed-duration, high volume)."
    )
    parser.add_argument("--devices", type=int, default=DEFAULT_DEVICES,
                        help=f"simulated pumping units (default: {DEFAULT_DEVICES})")
    parser.add_argument("--hz", type=float, default=DEFAULT_HZ,
                        help=f"samples/second PER SENSOR (default: {DEFAULT_HZ})")
    parser.add_argument("--duration", type=float, default=DEFAULT_DURATION_S,
                        help=f"burst length in seconds, then hard stop (default: {DEFAULT_DURATION_S})")
    parser.add_argument("--host", default=os.environ.get("MQTT_HOST", "localhost"),
                        help="MQTT broker host (default: $MQTT_HOST or localhost)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("MQTT_PORT", "1883")),
                        help="MQTT broker port (default: $MQTT_PORT or 1883)")
    parser.add_argument("--site-prefix", default=os.environ.get("SITE_ID", "frac-fleet"),
                        help="site-id prefix; each device is <prefix>-NN (default: $SITE_ID or frac-fleet)")
    args = parser.parse_args()

    if args.devices < 1 or args.hz <= 0 or args.duration <= 0:
        print("[burst] --devices, --hz and --duration must all be positive", file=sys.stderr)
        sys.exit(2)

    # One correlated simulation engine per simulated pumping unit, pre-warmed so
    # values are plausible from the first message.
    engines = [SimulationEngine() for _ in range(args.devices)]
    for engine in engines:
        for _ in range(20):
            engine.read_all()

    try:
        client = connect_mqtt(args.host, args.port, args.site_prefix)
    except Exception as exc:
        print(f"[mqtt] failed to connect: {exc}", file=sys.stderr)
        sys.exit(1)
    time.sleep(0.5)  # let the connection establish

    summary = run_burst(client, engines, args)

    client.loop_stop()
    client.disconnect()

    print("\n[burst] ---------- SUMMARY ----------", flush=True)
    print(f"[burst] devices          : {summary['devices']}", flush=True)
    print(f"[burst] sensors/device   : {summary['sensors_per_device']}", flush=True)
    print(f"[burst] messages sent    : {summary['messages_sent']}", flush=True)
    print(f"[burst] duration         : {summary['duration_s']} s", flush=True)
    print(f"[burst] achieved rate    : {summary['achieved_rate_msg_s']} msg/s", flush=True)
    print("[burst] burst complete — pipeline will now drain back to baseline.", flush=True)


if __name__ == "__main__":
    main()
