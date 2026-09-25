#!/usr/bin/env python3
"""
Local frac-op load generator -> direct-to-MSK producer.

Runs the SAME correlated frac-op sensor model as ``sensor-sim.py`` /
``frac-op-burst.py``, but instead of publishing MQTT to a local Mosquitto
broker, it produces DIRECTLY to the cloud MSK cluster over SASL_SCRAM, so an
operator's laptop can push configurable-volume frac telemetry straight into
the pipeline and watch RisingWave / TimescaleDB / InfluxDB freshness and
query latency respond to load (see
docs/superpowers/specs/2026-09-09-frac-load-and-dashboard-timeseries-design.md).

This does NOT invent a new telemetry schema or a new topic naming scheme. It
reuses the exact payload schema and correlated sensor model from
``sensor-sim.py`` (imported by path, the same trick ``frac-op-burst.py``
already uses) and the SCRAM/bootstrap-broker recipe from
``scripts/create-msk-topics.sh``: SASL_SSL + SCRAM-SHA-512, credentials from
Secrets Manager secret ``AmazonMSK_workshop-<slot>``, brokers from
``aws kafka get-bootstrap-brokers ... BootstrapBrokerStringSaslScram``.

Target topic: ``sensors.raw.sim`` (schema-matched, reaches RisingWave +
TimescaleDB + InfluxDB with zero pipeline changes). ``site_id`` is always
``<slot>-<site-prefix>NN-pumpMM`` so it carries the ``ws-slotNN`` prefix that
``deployment_id`` is derived from downstream (risingwave/ddl-cloud.sql's
``sim_all_slots`` view).

Usage:
  python simulator/frac-msk-load.py --slot ws-slot00 --dry-run
  python simulator/frac-msk-load.py --slot ws-slot00 --sites 3 --units-per-site 2 --hz 5 --duration 120
  python simulator/frac-msk-load.py --slot ws-slot00 --hz 50 --duration 60   # stress
"""

import argparse
import importlib.util
import json
import os
import sys
import threading
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Reuse the telemetry schema + correlated sensor model from sensor-sim.py.
# The filename is hyphenated (not an importable module name), so load it by
# path, same trick frac-op-burst.py already uses. Importing is side-effect
# free: sensor-sim.py only connects to MQTT inside its own
# `if __name__ == "__main__"` guard, not at import time.
# ---------------------------------------------------------------------------
_SIM_PATH = Path(__file__).with_name("sensor-sim.py")
_spec = importlib.util.spec_from_file_location("sensor_sim", _SIM_PATH)
sensor_sim = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sensor_sim)

SENSORS = sensor_sim.SENSORS
SimulationEngine = sensor_sim.SimulationEngine
build_payload = sensor_sim.build_payload

# ---------------------------------------------------------------------------
# CLI defaults
# ---------------------------------------------------------------------------
DEFAULT_TOPIC = "sensors.raw.sim"
DEFAULT_SITES = 3
DEFAULT_UNITS_PER_SITE = 2
DEFAULT_HZ = 1.0
DEFAULT_DURATION_S = 120
DEFAULT_REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"


def build_site_id(slot: str, site_idx: int, unit_idx: int) -> str:
    """<slot>-frac-siteNN-pumpMM — always starts with the ws-slotNN prefix
    that deployment_id derivation (risingwave/ddl-cloud.sql: sim_all_slots)
    depends on."""
    return f"{slot}-frac-site{site_idx:02d}-pump{unit_idx:02d}"


# ---------------------------------------------------------------------------
# MSK connection — same recipe as scripts/create-msk-topics.sh, via boto3.
# ---------------------------------------------------------------------------
def resolve_msk_connection(slot: str, region: str) -> tuple:
    """Returns (bootstrap_brokers, username, password) for the shared MSK
    cluster, using the same Secrets Manager secret + bootstrap-broker lookup
    as scripts/create-msk-topics.sh."""
    import boto3

    secretsmanager = boto3.client("secretsmanager", region_name=region)
    secret = secretsmanager.get_secret_value(SecretId=f"AmazonMSK_workshop-{slot}")
    creds = json.loads(secret["SecretString"])
    username, password = creds["username"], creds["password"]

    kafka = boto3.client("kafka", region_name=region)
    clusters = kafka.list_clusters_v2(ClusterNameFilter=f"workshop-{slot}-msk")["ClusterInfoList"]
    if not clusters:
        # Shared platform cluster fallback (see amplify/custom/platform-stack.ts).
        clusters = kafka.list_clusters_v2(ClusterNameFilter="workshop-platform-msk")["ClusterInfoList"]
    if not clusters:
        raise RuntimeError(f"no MSK cluster found for slot {slot}")
    cluster_arn = clusters[0]["ClusterArn"]

    brokers = kafka.get_bootstrap_brokers(ClusterArn=cluster_arn)
    bootstrap = brokers["BootstrapBrokerStringSaslScram"]
    return bootstrap, username, password


def connect_producer(bootstrap: str, username: str, password: str):
    from kafka import KafkaProducer

    return KafkaProducer(
        bootstrap_servers=bootstrap.split(","),
        security_protocol="SASL_SSL",
        sasl_mechanism="SCRAM-SHA-512",
        sasl_plain_username=username,
        sasl_plain_password=password,
        value_serializer=lambda v: v,  # payload is already JSON bytes
        # A load run is a burst by design; a deep buffer avoids blocking the
        # pacing loop on producer.send() backpressure, mirroring
        # frac-op-burst.py's max_queued_messages_set(0) intent for MQTT.
        max_block_ms=5000,
        linger_ms=20,
    )


# ---------------------------------------------------------------------------
# Load loop — mirrors frac-op-burst.py's fixed-rate pacing + hard-stop
# watchdog guarantees, adapted to per-site/per-unit engines and a Kafka
# producer instead of one MQTT client.
# ---------------------------------------------------------------------------
def run_load(producer, engines: dict, topic: str, args) -> dict:
    """Publish every sensor for every (site, unit) engine at ``args.hz`` for
    ``args.duration`` seconds, then stop hard. Returns a summary dict.

    Termination is guaranteed by two independent mechanisms, mirroring
    frac-op-burst.py:
      1. the loop's own monotonic deadline check (primary), and
      2. a hard-backstop Timer that force-exits a few seconds past the
         deadline if the loop somehow overruns.
    """
    stop = threading.Event()

    start = time.monotonic()
    deadline = start + args.duration
    tick_interval = 1.0 / args.hz
    n_sensors = len(SENSORS)
    sent = 0
    ticks = 0

    hard = threading.Timer(args.duration + 5.0, lambda: os._exit(0))
    hard.daemon = True
    hard.start()

    n_engines = len(engines)
    print(
        f"[load] START — sites={args.sites} units/site={args.units_per_site} "
        f"hz={args.hz} sensors/unit={n_sensors} "
        f"target={n_engines * n_sensors * args.hz:.0f} msg/s "
        f"duration={args.duration}s topic={topic}",
        flush=True,
    )

    next_tick = start
    while not stop.is_set():
        now = time.monotonic()
        if now >= deadline:
            break

        for site_id, engine in engines.items():
            readings = engine.read_all()
            for name, unit, _interval, _lo, _hi in SENSORS:
                payload = build_payload(name, readings[name], unit, site_id)
                producer.send(topic, value=payload)
                sent += 1
        ticks += 1

        if ticks % int(max(1, args.hz)) == 0:  # ~once/second progress line
            elapsed = now - start
            rate = sent / elapsed if elapsed > 0 else 0.0
            print(f"[load] t={elapsed:6.1f}s  sent={sent:>9}  rate={rate:8.1f} msg/s", flush=True)

        next_tick += tick_interval
        sleep_for = next_tick - time.monotonic()
        if sleep_for > 0:
            stop.wait(sleep_for)

    hard.cancel()
    producer.flush(timeout=10)
    elapsed = time.monotonic() - start
    return {
        "messages_sent": sent,
        "ticks": ticks,
        "duration_s": round(elapsed, 2),
        "achieved_rate_msg_s": round(sent / elapsed, 1) if elapsed > 0 else 0.0,
        "sites": args.sites,
        "units_per_site": args.units_per_site,
        "sensors_per_unit": n_sensors,
    }


def run_dry_run(engines: dict, topic: str, args) -> None:
    """Print one sample payload per site (not per unit — keeps output short)
    without touching AWS/Kafka at all, so `--dry-run` works fully offline."""
    print(f"[dry-run] topic={topic} sites={args.sites} units/site={args.units_per_site} hz={args.hz}", flush=True)
    seen_sites = set()
    for site_id, engine in engines.items():
        site_prefix = site_id.rsplit("-pump", 1)[0]
        if site_prefix in seen_sites:
            continue
        seen_sites.add(site_prefix)
        readings = engine.read_all()
        for name, unit, _interval, _lo, _hi in SENSORS:
            payload = build_payload(name, readings[name], unit, site_id)
            print(f"  {topic}  {payload.decode('utf-8')}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Local frac-op load generator -> direct-to-MSK producer."
    )
    parser.add_argument("--slot", required=True, help="workshop deployment slot, e.g. ws-slot00")
    parser.add_argument("--sites", type=int, default=DEFAULT_SITES,
                        help=f"simulated frac sites (default: {DEFAULT_SITES})")
    parser.add_argument("--units-per-site", type=int, default=DEFAULT_UNITS_PER_SITE,
                        help=f"simulated pumping units per site (default: {DEFAULT_UNITS_PER_SITE})")
    parser.add_argument("--hz", type=float, default=DEFAULT_HZ,
                        help=f"samples/second PER SENSOR (default: {DEFAULT_HZ})")
    parser.add_argument("--duration", type=float, default=DEFAULT_DURATION_S,
                        help=f"load length in seconds, then hard stop (default: {DEFAULT_DURATION_S})")
    parser.add_argument("--topic", default=DEFAULT_TOPIC,
                        help=f"target MSK topic (default: {DEFAULT_TOPIC})")
    parser.add_argument("--region", default=DEFAULT_REGION,
                        help=f"AWS region (default: {DEFAULT_REGION})")
    parser.add_argument("--dry-run", action="store_true",
                        help="print sample payloads and exit — no AWS/Kafka connection")
    args = parser.parse_args()

    if not args.slot.startswith("ws-slot"):
        print("[load] --slot must look like ws-slotNN", file=sys.stderr)
        sys.exit(2)
    if args.sites < 1 or args.units_per_site < 1 or args.hz <= 0 or args.duration <= 0:
        print("[load] --sites, --units-per-site, --hz and --duration must all be positive", file=sys.stderr)
        sys.exit(2)

    engines = {}
    for site_idx in range(args.sites):
        for unit_idx in range(args.units_per_site):
            site_id = build_site_id(args.slot, site_idx, unit_idx)
            engine = SimulationEngine()
            for _ in range(20):  # pre-warm so values are plausible from the first message
                engine.read_all()
            engines[site_id] = engine

    if args.dry_run:
        run_dry_run(engines, args.topic, args)
        return

    try:
        bootstrap, username, password = resolve_msk_connection(args.slot, args.region)
    except Exception as exc:
        print(f"[load] failed to resolve MSK connection: {exc}", file=sys.stderr)
        sys.exit(1)

    print(f"[load] bootstrap brokers: {bootstrap}", flush=True)

    try:
        producer = connect_producer(bootstrap, username, password)
    except Exception as exc:
        print(f"[load] failed to connect to MSK: {exc}", file=sys.stderr)
        sys.exit(1)

    summary = run_load(producer, engines, args.topic, args)
    producer.close()

    print("\n[load] ---------- SUMMARY ----------", flush=True)
    print(f"[load] sites             : {summary['sites']}", flush=True)
    print(f"[load] units/site        : {summary['units_per_site']}", flush=True)
    print(f"[load] sensors/unit      : {summary['sensors_per_unit']}", flush=True)
    print(f"[load] messages sent     : {summary['messages_sent']}", flush=True)
    print(f"[load] duration          : {summary['duration_s']} s", flush=True)
    print(f"[load] achieved rate     : {summary['achieved_rate_msg_s']} msg/s", flush=True)


if __name__ == "__main__":
    main()
