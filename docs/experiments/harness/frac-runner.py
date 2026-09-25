#!/usr/bin/env python3
"""In-pod wrapper around simulator/frac-msk-load.py.

Deployed to each load pod at /tmp/frac-runner.py alongside a copy of
simulator/frac-msk-load.py at /tmp/frac-msk-load.py (see harness/README.md).

The load pods carry MSK SASL/SCRAM creds via the `msk-credentials` secret
(env MSK_BOOTSTRAP_SERVERS / MSK_USERNAME / MSK_PASSWORD) and have NO AWS
credentials, so we cannot use fml.resolve_msk_connection() (it calls
Secrets Manager + the kafka API). This wrapper builds the same engines main()
does, then connects the producer straight from env and calls fml.run_load().

Slot-agnostic: --slot is passed through, nothing here is hardcoded to a slot.
"""
import argparse
import importlib.util
import os
import sys

# Load the committed generator module from /tmp (copied in alongside this file).
_spec = importlib.util.spec_from_file_location("fml", "/tmp/frac-msk-load.py")
fml = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fml)


def main() -> None:
    p = argparse.ArgumentParser(description="In-pod MSK load runner (env creds).")
    p.add_argument("--slot", required=True)
    p.add_argument("--sites", type=int, default=20)
    p.add_argument("--units-per-site", type=int, default=2)
    p.add_argument("--hz", type=float, default=1.0)
    p.add_argument("--duration", type=float, default=60.0)
    p.add_argument("--topic", default=fml.DEFAULT_TOPIC)
    args = p.parse_args()

    bootstrap = os.environ["MSK_BOOTSTRAP_SERVERS"]
    username = os.environ["MSK_USERNAME"]
    password = os.environ["MSK_PASSWORD"]

    engines = {}
    for site_idx in range(args.sites):
        for unit_idx in range(args.units_per_site):
            site_id = fml.build_site_id(args.slot, site_idx, unit_idx)
            engine = fml.SimulationEngine()
            for _ in range(20):  # pre-warm so values are plausible from msg 1
                engine.read_all()
            engines[site_id] = engine

    print(f"[runner] bootstrap={bootstrap}", flush=True)
    producer = fml.connect_producer(bootstrap, username, password)
    summary = fml.run_load(producer, engines, args.topic, args)
    producer.close()
    print(f"[runner] SUMMARY {summary}", flush=True)


if __name__ == "__main__":
    main()
