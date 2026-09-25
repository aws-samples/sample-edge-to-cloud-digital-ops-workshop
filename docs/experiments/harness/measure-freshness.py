#!/usr/bin/env python3
"""Freshness / CAGG ramp harness for the data-store comparison experiment.

Parameterized rewrite of the /tmp/ramp_freshness.py + /tmp/remeasure_cagg.py
scripts that produced the (TSDB-only) numbers in the load-test blog. Drives the
frac load generator on N pods per rung, warms up, then samples TimescaleDB
freshness metrics every few seconds and reports per-rung median/min/max/p95.

SCOPE / HONESTY NOTE
--------------------
As committed this measures the **TimescaleDB** path only:
  frac_freshest   : now - MAX(ts_ms) over frac sites        (footnote's claimed metric)
  frac_stalest    : now - MIN(per-site MAX) over frac sites (mask-proof headline)
  overall_freshest: now - MAX(ts_ms) over ALL sites         (old masked toPayload)
  all_stalest     : now - MIN(per-site MAX) over ALL sites  (new toPayload, fleet)
  cagg_frac       : now - MAX(max_ts_ms) from CAGG          (real-time read)

The "Full fair harness" (RisingWave MV + InfluxDB freshness, the Q4 analytical
aggregation with latency+result, and the per-hop decomposition from the
db_insert_ts / broker_ts_ms / connect_recv_ts_ms columns) is described in
../2026-09-25-fair-datastore-comparison-spec.md §5-§6 and is NOT yet implemented
here. `sample()` is the single place to add the RW/InfluxDB/Q4 queries so every
store is read in the same window. Look for the "EXTEND HERE" markers.

Usage:
  python3 measure-freshness.py --slot ws-slot42 [--namespace ws-slot42] \
      [--pg-pod timescaledb-cloud-1] [--rungs full|cagg] [--out results.json]

Requires: kubectl context on the workshop EKS cluster; load pods
frac-load-big{,2..6} present in --namespace, each carrying /tmp/frac-runner.py +
/tmp/frac-msk-load.py (see README.md).
"""
import argparse
import json
import statistics
import subprocess
import time
from datetime import datetime, timezone

# --- rung tables (offered_rate_label, n_pods, hz_per_pod) ---
RUNGS_FULL = [
    ("114/s",     1, 0.3),
    ("~9,000/s",  1, 25.0),
    ("~13,000/s", 1, 36.0),
    ("~27,000/s", 2, 37.5),
    ("~35,000/s", 3, 37.0),
    ("~63,000/s", 6, 31.0),
]
RUNGS_CAGG = [  # the 3-rung control that confirmed the grid-alignment fix
    ("~13,000/s", 1, 36.0),
    ("~35,000/s", 3, 37.0),
    ("~63,000/s", 6, 31.0),
]

WARMUP = 70
SAMPLE_WINDOW = 75
SAMPLE_EVERY = 5
EXTRA = 30            # generator duration past the sample window
DISK_ABORT = 88       # abort a rung if the TSDB data volume passes this %


def sh(args, timeout=90):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


class Harness:
    def __init__(self, slot, namespace, pg_pod):
        self.slot = slot
        self.ns = namespace
        self.pg_pod = pg_pod
        self.frac_like = f"{slot}-frac-%"      # site_id prefix produced by frac-runner
        self.deployment_id = slot
        self.pods = [f"frac-load-big{'' if i == 1 else i}" for i in range(1, 7)]
        self.pg = ["kubectl", "exec", "-n", namespace, pg_pod, "-c", "postgres", "--",
                   "psql", "-U", "postgres", "-d", "edge", "-A", "-t", "-F", "\t"]

    # ---- metrics ----
    def _metrics_sql(self):
        return f"""
SET statement_timeout='25s';
WITH w AS (SELECT site_id, ts_ms, (site_id LIKE '{self.frac_like}') AS is_frac
           FROM sensor_readings WHERE partition_time > now() - interval '2 minutes'),
per AS (SELECT site_id, bool_or(is_frac) is_frac, MAX(ts_ms) m FROM w GROUP BY site_id)
SELECT
  (SELECT round(EXTRACT(EPOCH FROM now())*1000 - MAX(m)) FROM per WHERE is_frac),
  (SELECT round(EXTRACT(EPOCH FROM now())*1000 - MIN(m)) FROM per WHERE is_frac),
  (SELECT round(EXTRACT(EPOCH FROM now())*1000 - MAX(m)) FROM per),
  (SELECT round(EXTRACT(EPOCH FROM now())*1000 - MIN(m)) FROM per),
  (SELECT round(EXTRACT(EPOCH FROM now())*1000 - MAX(max_ts_ms))
     FROM sensor_readings_cagg WHERE bucket > now()-interval '2 minutes'
       AND deployment_id='{self.deployment_id}'),
  (SELECT count(*) FROM w WHERE is_frac);
"""

    def sample(self):
        r = sh(self.pg + ["-c", self._metrics_sql()])
        for line in r.stdout.splitlines():
            cells = line.split("\t")
            if len(cells) == 6:
                def num(x):
                    x = x.strip()
                    return float(x) if x not in ("", "NULL") else None
                out = dict(zip(
                    ["frac_freshest", "frac_stalest", "overall_freshest",
                     "all_stalest", "cagg_frac", "frac_rows_2m"],
                    [num(c) for c in cells]))
                # --- EXTEND HERE: add RW MV, InfluxDB, and Q4 aggregation reads ---
                # e.g. out["rw_frac_stalest"] = self.rw_freshness()
                #      out["agg_tsdb_raw_ms"], out["agg_tsdb_raw_val"] = self.q4_tsdb_raw()
                # so all stores are sampled in the SAME window. See spec §5.2 / §6.
                return out
        return None

    def disk_pct(self):
        r = sh(["kubectl", "exec", "-n", self.ns, self.pg_pod, "-c", "postgres", "--",
                "df", "--output=pcent", "/var/lib/postgresql/data"])
        try:
            return int(r.stdout.strip().splitlines()[-1].strip().rstrip("%"))
        except Exception:
            return -1

    # ---- load control ----
    def _kill_cmd(self):
        return ("for pid in $(ps -eo pid,args 2>/dev/null | grep frac-runner | "
                "grep -v grep | awk '{print $1}'); do kill $pid 2>/dev/null; done")

    def launch(self, pod, hz, dur):
        cmd = (f"{self._kill_cmd()}; sleep 1; "
               f"setsid python3 /tmp/frac-runner.py --slot {self.slot} --sites 20 "
               f"--units-per-site 2 --hz {hz} --duration {dur} "
               ">/tmp/load.log 2>&1 </dev/null & sleep 1; echo launched")
        return sh(["kubectl", "-n", self.ns, "exec", pod, "--", "sh", "-c", cmd], timeout=40)

    def idle(self, pod):
        sh(["kubectl", "-n", self.ns, "exec", pod, "--", "sh", "-c", self._kill_cmd()], timeout=30)

    def killall(self):
        for p in self.pods:
            self.idle(p)


def med(xs, k):
    vals = [s[k] for s in xs if s and s.get(k) is not None]
    if not vals:
        return None
    vals.sort()
    return {"n": len(vals), "median": round(statistics.median(vals)),
            "min": round(min(vals)), "max": round(max(vals)),
            "p95": round(vals[min(len(vals) - 1, int(round(0.95 * (len(vals) - 1))))])}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--slot", required=True, help="deployment slot, e.g. ws-slot42")
    ap.add_argument("--namespace", help="k8s namespace (default: same as --slot)")
    ap.add_argument("--pg-pod", default="timescaledb-cloud-1")
    ap.add_argument("--rungs", choices=["full", "cagg"], default="full")
    ap.add_argument("--out", default="freshness_results.json")
    args = ap.parse_args()
    ns = args.namespace or args.slot
    rungs = RUNGS_FULL if args.rungs == "full" else RUNGS_CAGG
    dur = WARMUP + SAMPLE_WINDOW + EXTRA

    h = Harness(args.slot, ns, args.pg_pod)
    results = []
    try:
        for label, npods, hz in rungs:
            print(f"\n### RUNG {label}  pods={npods} hz={hz}  "
                  f"({datetime.now(timezone.utc).strftime('%H:%M:%S')}Z)", flush=True)
            for p in h.pods[:npods]:
                print("  launch", p, h.launch(p, hz, dur).stdout.strip(), flush=True)
            for p in h.pods[npods:]:
                h.idle(p)
            print(f"  warmup {WARMUP}s...", flush=True)
            time.sleep(WARMUP)
            dp = h.disk_pct()
            if dp >= DISK_ABORT:
                print(f"  !! disk {dp}% >= {DISK_ABORT}, ABORT", flush=True)
                break
            samples = []
            t_end = time.time() + SAMPLE_WINDOW
            while time.time() < t_end:
                s = h.sample()
                if s:
                    samples.append(s)
                    print("   ", {k: (round(v) if v is not None else None) for k, v in s.items()}, flush=True)
                time.sleep(SAMPLE_EVERY)
            frac_rows = [s["frac_rows_2m"] for s in samples if s and s.get("frac_rows_2m")]
            landed_rate = round(max(frac_rows) / 120.0) if frac_rows else None
            rung = {"rung": label, "pods": npods, "hz": hz, "disk_pct": dp,
                    "frac_landed_rows_s": landed_rate,
                    "frac_freshest_ms": med(samples, "frac_freshest"),
                    "overall_freshest_ms": med(samples, "overall_freshest"),
                    "frac_stalest_ms": med(samples, "frac_stalest"),
                    "all_stalest_ms": med(samples, "all_stalest"),
                    "cagg_frac_ms": med(samples, "cagg_frac")}
            results.append(rung)
            print("  RUNG SUMMARY:", json.dumps(rung), flush=True)
            json.dump(results, open(args.out, "w"), indent=1)
    finally:
        h.killall()
        json.dump(results, open(args.out, "w"), indent=1)
        print("\n=== DONE, killed load, results ->", args.out, flush=True)


if __name__ == "__main__":
    main()
