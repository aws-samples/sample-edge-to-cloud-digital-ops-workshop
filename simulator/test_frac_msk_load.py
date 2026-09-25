#!/usr/bin/env python3
"""
Schema test for frac-msk-load.py's --dry-run output (#271).

Runs entirely offline: --dry-run never touches AWS/Kafka (see
resolve_msk_connection / connect_producer, which are only called outside the
--dry-run branch in main()), so this asserts the frac payload schema and the
ws-slotNN site_id prefix without any live dependency or AWS credentials --
matching the epic's offline/static acceptance bar.

Usage:
  python3 simulator/test_frac_msk_load.py
  python3 -m unittest discover -s simulator -p "test_*.py"
"""

import importlib.util
import io
import json
import re
import unittest
from contextlib import redirect_stdout
from pathlib import Path

_MODULE_PATH = Path(__file__).with_name("frac-msk-load.py")
_spec = importlib.util.spec_from_file_location("frac_msk_load", _MODULE_PATH)
frac_msk_load = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(frac_msk_load)

EXPECTED_FIELDS = {"sensor", "value", "unit", "ts_ms", "site_id"}
SITE_ID_RE = re.compile(r"^ws-slot\d+-")


class _DryRunArgs:
    """Minimal stand-in for the argparse.Namespace run_dry_run() reads."""
    slot = "ws-slot07"
    sites = 2
    units_per_site = 1
    hz = 1.0
    duration = 60
    topic = "sensors.raw.sim"
    region = "us-east-1"
    dry_run = True


def _capture_dry_run_payloads() -> list:
    """Builds the same engine dict main() would for --dry-run, runs
    run_dry_run(), and returns the parsed JSON payload dicts it printed."""
    engines = {}
    for site_idx in range(_DryRunArgs.sites):
        for unit_idx in range(_DryRunArgs.units_per_site):
            site_id = frac_msk_load.build_site_id(_DryRunArgs.slot, site_idx, unit_idx)
            engines[site_id] = frac_msk_load.SimulationEngine()

    buf = io.StringIO()
    with redirect_stdout(buf):
        frac_msk_load.run_dry_run(engines, _DryRunArgs.topic, _DryRunArgs)

    # run_dry_run prints exactly `f"  {topic}  {payload}"` per payload line
    # (see frac-msk-load.py) — match that prefix precisely so the leading
    # `[dry-run] topic=... ` summary line (which also contains the topic
    # string) isn't mistaken for a payload line.
    prefix = f"  {_DryRunArgs.topic}  "
    return [
        json.loads(line[len(prefix):])
        for line in buf.getvalue().splitlines()
        if line.startswith(prefix)
    ]


class FracMskLoadSchemaTest(unittest.TestCase):
    def test_dry_run_prints_frac_schema(self):
        payloads = _capture_dry_run_payloads()
        self.assertGreater(len(payloads), 0, "dry-run printed no payload lines")

        for payload in payloads:
            self.assertEqual(set(payload.keys()), EXPECTED_FIELDS)
            self.assertIsInstance(payload["sensor"], str)
            self.assertIsInstance(payload["value"], (int, float))
            self.assertIsInstance(payload["unit"], str)
            self.assertIsInstance(payload["ts_ms"], int)
            self.assertIsInstance(payload["site_id"], str)
            self.assertRegex(payload["site_id"], SITE_ID_RE)

    def test_site_id_matches_source_slot(self):
        payloads = _capture_dry_run_payloads()
        for payload in payloads:
            self.assertTrue(payload["site_id"].startswith(_DryRunArgs.slot + "-"))

    def test_build_site_id_prefix(self):
        site_id = frac_msk_load.build_site_id("ws-slot42", 3, 1)
        self.assertTrue(site_id.startswith("ws-slot42-"))
        self.assertRegex(site_id, SITE_ID_RE)


if __name__ == "__main__":
    unittest.main()
