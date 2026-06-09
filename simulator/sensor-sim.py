#!/usr/bin/env python3
"""
Hydraulic fracturing wellsite sensor simulator.
Publishes MQTT messages to a local broker at 1 Hz (or per-sensor rate).

Config (env vars):
  MQTT_HOST  - broker hostname (default: localhost)
  MQTT_PORT  - broker port    (default: 1883)
  SITE_ID    - site identifier (default: sim-site-01)

Usage:
  python sensor-sim.py          # run forever
  python sensor-sim.py --once   # publish one batch and exit
"""

import argparse
import json
import math
import os
import random
import signal
import sys
import time

import paho.mqtt.client as mqtt

# ---------------------------------------------------------------------------
# Config from environment
# ---------------------------------------------------------------------------
MQTT_HOST = os.environ.get("MQTT_HOST", "localhost")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
SITE_ID = os.environ.get("SITE_ID", "sim-site-01")

# ---------------------------------------------------------------------------
# Sensor definitions
# name, unit, publish_interval_s, value_range (min, max)
# ---------------------------------------------------------------------------
SENSORS = [
    ("pump_pressure_1",    "PSI",    1.0,  1500.0,  8000.0),
    ("pump_pressure_2",    "PSI",    1.0,  1500.0,  8000.0),
    ("pump_pressure_3",    "PSI",    1.0,  1500.0,  8000.0),
    ("slurry_flow_bpm",    "BPM",    1.0,    10.0,   100.0),
    ("blender_rpm",        "RPM",    1.0,   100.0,   500.0),
    ("wellhead_pressure",  "PSI",    1.0,  2000.0, 10000.0),
    ("proppant_conc_lb_gal", "lb/gal", 2.0,   0.0,     4.0),
    ("annular_pressure",   "PSI",    1.0,   100.0,  2000.0),
    ("surface_temp_f",     "°F",     5.0,    60.0,   180.0),
]

# ---------------------------------------------------------------------------
# Simulation state — smoothly wandering "base" value for each sensor
# ---------------------------------------------------------------------------
class SensorState:
    """Tracks a smoothly-wandering midpoint for one sensor channel."""

    def __init__(self, name: str, unit: str, interval: float, lo: float, hi: float):
        self.name = name
        self.unit = unit
        self.interval = interval
        self.lo = lo
        self.hi = hi
        # Initialise the wandering midpoint at a random position in the range
        self.midpoint = random.uniform(lo + (hi - lo) * 0.2, hi - (hi - lo) * 0.2)
        # Slow drift velocity (units/s)
        span = hi - lo
        self.velocity = random.uniform(-span * 0.02, span * 0.02)
        self.last_published = 0.0

    def _clamp(self, val: float) -> float:
        return max(self.lo, min(self.hi, val))

    def step(self) -> float:
        """Advance midpoint by one simulation tick and return a noisy reading."""
        span = self.hi - self.lo
        # Randomly nudge velocity (random walk)
        self.velocity += random.uniform(-span * 0.005, span * 0.005)
        # Clamp velocity so it doesn't run away
        max_vel = span * 0.03
        self.velocity = max(-max_vel, min(max_vel, self.velocity))
        # Elastic restoring force toward centre (prevents rail-to-rail drift)
        centre = (self.hi + self.lo) / 2.0
        self.velocity += (centre - self.midpoint) * 0.002
        self.midpoint = self._clamp(self.midpoint + self.velocity)
        # Add small gaussian noise on top
        noise = random.gauss(0, span * 0.005)
        return self._clamp(self.midpoint + noise)


# ---------------------------------------------------------------------------
# Correlated state
# Pump pressure (average of 3 trucks) loosely drives wellhead pressure.
# Slurry flow drives blender RPM.
# ---------------------------------------------------------------------------
class SimulationEngine:
    def __init__(self):
        self.states: dict[str, SensorState] = {}
        for name, unit, interval, lo, hi in SENSORS:
            self.states[name] = SensorState(name, unit, interval, lo, hi)

    def read_all(self) -> dict[str, float]:
        """Step every sensor and apply cross-sensor correlations."""
        readings: dict[str, float] = {}

        # Step all sensors independently first
        for name, state in self.states.items():
            readings[name] = state.step()

        # --- Correlation: wellhead pressure tracks avg pump pressure ---
        # wellhead is ~80-105 % of average pump pressure, with noise
        avg_pump = (
            readings["pump_pressure_1"]
            + readings["pump_pressure_2"]
            + readings["pump_pressure_3"]
        ) / 3.0
        # Map avg_pump (1500-8000) into wellhead range (2000-10000)
        pump_lo, pump_hi = 1500.0, 8000.0
        wh_lo, wh_hi = 2000.0, 10000.0
        pump_norm = (avg_pump - pump_lo) / (pump_hi - pump_lo)
        wh_correlated = wh_lo + pump_norm * (wh_hi - wh_lo)
        # Blend 70 % correlated, 30 % independent wandering
        readings["wellhead_pressure"] = (
            0.70 * wh_correlated + 0.30 * readings["wellhead_pressure"]
        )
        readings["wellhead_pressure"] = max(wh_lo, min(wh_hi, readings["wellhead_pressure"]))
        # Keep the internal state midpoint in sync to avoid violent snapping
        self.states["wellhead_pressure"].midpoint = readings["wellhead_pressure"]

        # --- Correlation: blender RPM tracks slurry flow ---
        # Blender RPM (100-500) scales with slurry flow (10-100)
        flow_norm = (readings["slurry_flow_bpm"] - 10.0) / (100.0 - 10.0)
        rpm_correlated = 100.0 + flow_norm * (500.0 - 100.0)
        readings["blender_rpm"] = (
            0.65 * rpm_correlated + 0.35 * readings["blender_rpm"]
        )
        readings["blender_rpm"] = max(100.0, min(500.0, readings["blender_rpm"]))
        self.states["blender_rpm"].midpoint = readings["blender_rpm"]

        return readings


# ---------------------------------------------------------------------------
# MQTT helpers
# ---------------------------------------------------------------------------
def build_topic(site_id: str, sensor_name: str) -> str:
    return f"sensors/raw/{site_id}/{sensor_name}"


def build_payload(sensor_name: str, value: float, unit: str, site_id: str) -> bytes:
    ts_ms = int(time.time() * 1000)
    doc = {
        "sensor": sensor_name,
        "value": round(value, 4),
        "unit": unit,
        "ts_ms": ts_ms,
        "site_id": site_id,
    }
    return json.dumps(doc).encode("utf-8")


def connect_mqtt() -> mqtt.Client:
    client = mqtt.Client(client_id=f"sensor-sim-{SITE_ID}", clean_session=True)

    def on_connect(c, userdata, flags, rc):
        if rc == 0:
            print(f"[mqtt] connected to {MQTT_HOST}:{MQTT_PORT}", flush=True)
        else:
            print(f"[mqtt] connection failed, rc={rc}", flush=True)

    def on_disconnect(c, userdata, rc):
        if rc != 0:
            print(f"[mqtt] unexpected disconnect rc={rc}, will reconnect…", flush=True)

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
    client.loop_start()
    return client


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
_running = True


def _handle_sigint(signum, frame):
    global _running
    print("\n[sim] interrupted, shutting down…", flush=True)
    _running = False


def run_once(client: mqtt.Client, engine: SimulationEngine) -> None:
    """Publish one reading for every sensor and return."""
    readings = engine.read_all()
    for name, unit, interval, lo, hi in SENSORS:
        value = readings[name]
        topic = build_topic(SITE_ID, name)
        payload = build_payload(name, value, unit, SITE_ID)
        result = client.publish(topic, payload, qos=0)
        print(f"  {topic}  {value:.2f} {unit}", flush=True)
    # Give paho a moment to flush the outgoing queue
    time.sleep(0.2)


def run_forever(client: mqtt.Client, engine: SimulationEngine) -> None:
    """Publish each sensor at its own rate until interrupted."""
    signal.signal(signal.SIGINT, _handle_sigint)
    signal.signal(signal.SIGTERM, _handle_sigint)

    # Track when each sensor last published
    last_pub: dict[str, float] = {name: 0.0 for name, *_ in SENSORS}
    sensor_meta: dict[str, tuple] = {
        name: (unit, interval, lo, hi)
        for name, unit, interval, lo, hi in SENSORS
    }

    # We step the engine at a fixed internal tick rate (10 Hz) for smoothness,
    # but only publish each sensor at its own declared rate.
    tick_interval = 0.1  # seconds

    print(
        f"[sim] starting — site={SITE_ID} broker={MQTT_HOST}:{MQTT_PORT}",
        flush=True,
    )

    # Pre-step a few times so values are plausible from the start
    for _ in range(20):
        engine.read_all()

    while _running:
        now = time.time()
        readings = engine.read_all()

        for name, (unit, interval, lo, hi) in sensor_meta.items():
            if now - last_pub[name] >= interval:
                value = readings[name]
                topic = build_topic(SITE_ID, name)
                payload = build_payload(name, value, unit, SITE_ID)
                client.publish(topic, payload, qos=0)
                last_pub[name] = now
                print(
                    f"[{time.strftime('%H:%M:%S')}] {topic:<55} {value:>10.3f} {unit}",
                    flush=True,
                )

        time.sleep(tick_interval)

    print("[sim] stopped.", flush=True)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(
        description="Hydraulic fracturing wellsite sensor simulator"
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Publish one batch of all sensors and exit (useful for testing)",
    )
    args = parser.parse_args()

    engine = SimulationEngine()

    try:
        client = connect_mqtt()
    except Exception as exc:
        print(f"[mqtt] failed to connect: {exc}", file=sys.stderr)
        sys.exit(1)

    # Wait briefly for the connection to establish
    time.sleep(0.5)

    if args.once:
        print(f"[sim] --once mode — site={SITE_ID} broker={MQTT_HOST}:{MQTT_PORT}")
        run_once(client, engine)
    else:
        run_forever(client, engine)

    client.loop_stop()
    client.disconnect()


if __name__ == "__main__":
    main()
