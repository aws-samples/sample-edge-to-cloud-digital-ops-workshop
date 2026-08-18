import { NextRequest, NextResponse } from "next/server";
import { queryRisingWaveFreshness, queryTimescaleDbFreshness } from "../../../lib/freshness-queries";

// Returned by GET /api/freshness?tier=risingwave|timescaledb|athena|influxdb
// Contains all four chart datasets in one call. The two live tiers are also
// pushed incrementally over /api/stream/{risingwave,timescaledb} (see #160) —
// this endpoint remains the source of truth for the initial page load and for
// the polled tiers (Athena, InfluxDB), which have no push mechanism (on-demand
// warehouse query / no InfluxDB subscribe primitive — see #231/#233).
export interface FreshnessPayload {
  // Chart 1 — data freshness per tier (single numbers, ms).
  // Freshness = now − MAX(ts): how stale the newest row is (a property of the
  // ingestion pipeline, not the read path).
  tierFreshness: {
    risingwave_ms: number | null;
    timescaledb_ms: number | null;
    athena_ms: number | null;
    influxdb_ms: number | null;
  };
  // Chart 1b — query latency per tier (single numbers, ms). Wall-clock to run
  // this tier's read. Distinct axis from freshness: this is the read-path cost
  // (in-memory MV vs relational scan vs warehouse round-trip vs managed-TSDB
  // query), independent of how stale the data is.
  tierLatency: {
    risingwave_ms: number | null;
    timescaledb_ms: number | null;
    athena_ms: number | null;
    influxdb_ms: number | null;
  };
  // Chart 1c — device→ingest hop latency (#245), ms. ingest_ts (IoT-Core-
  // stamped) minus message_timestamp (device-stamped immediately before
  // publish) — the device-side MQTT publish + network hop, upstream of any
  // data store (see the epic issue #246). Currently only computed on the
  // RisingWave leg (risingwave/ddl-cloud.sql:mv_device_hop_latency); other
  // tiers are null until wired up. Null also when no recent row carries
  // message_timestamp.
  deviceHopLatency: {
    risingwave_ms: number | null;
    timescaledb_ms: number | null;
    athena_ms: number | null;
    influxdb_ms: number | null;
  };
  // Chart 2 — fleet-wide free CPU and memory (percentage)
  fleetResources: {
    avg_free_cpu_pct: number | null;
    avg_free_mem_pct: number | null;
  };
  // Chart 3 — per-node time since last message (seconds)
  nodeAge: Array<{ site_id: string; age_seconds: number }>;
  source: "risingwave" | "timescaledb" | "athena" | "influxdb" | "mock";
  sampled_at: number; // epoch ms on server
}

function mockPayload(source: "risingwave" | "timescaledb" | "athena" | "influxdb" | "mock"): FreshnessPayload {
  const now = Date.now();
  const rw_ms = source === "risingwave" ? 350 + Math.random() * 200 : null;
  const ts_ms = source === "timescaledb" ? 1500 + Math.random() * 800 : null;
  const at_ms = source === "athena" ? 28000 + Math.random() * 5000 : null;
  // InfluxDB is a managed hot store fed by Telegraf on a 1s flush — fresh, but
  // polled (no subscribe primitive), so a touch behind the pushed live tiers.
  const ix_ms = source === "influxdb" ? 1200 + Math.random() * 600 : null;
  // Mock query latency: RW's in-memory MV is fastest, TSDB's scan a bit slower,
  // Athena's warehouse round-trip slowest — the ordering the read-path axis
  // is meant to show. InfluxDB's time-series query sits between TSDB and Athena.
  const rw_lat = source === "risingwave" ? 3 + Math.random() * 5 : null;
  const ts_lat = source === "timescaledb" ? 15 + Math.random() * 20 : null;
  const at_lat = source === "athena" ? 1200 + Math.random() * 800 : null;
  const ix_lat = source === "influxdb" ? 20 + Math.random() * 40 : null;
  // Device→ingest hop (#245): only mocked on the RisingWave leg, matching the
  // real query which is only computed there today. ~20-80ms reflects the
  // target post-#244 (persistent MQTT publisher) behaviour.
  const rw_hop = source === "risingwave" ? 20 + Math.random() * 60 : null;
  return {
    tierFreshness: {
      risingwave_ms: rw_ms,
      timescaledb_ms: ts_ms,
      athena_ms: at_ms,
      influxdb_ms: ix_ms,
    },
    tierLatency: {
      risingwave_ms: rw_lat,
      timescaledb_ms: ts_lat,
      athena_ms: at_lat,
      influxdb_ms: ix_lat,
    },
    deviceHopLatency: {
      risingwave_ms: rw_hop,
      timescaledb_ms: null,
      athena_ms: null,
      influxdb_ms: null,
    },
    fleetResources: {
      avg_free_cpu_pct: 85 + Math.random() * 10,
      avg_free_mem_pct: 60 + Math.random() * 10,
    },
    nodeAge: ["ws-slot00-edge-0", "ws-slot00-edge-1", "ws-slot00-edge-2"].map(
      (id, i) => ({ site_id: id, age_seconds: (i + 1) * 1.2 + Math.random() * 0.5 })
    ),
    source,
    sampled_at: now,
  };
}

export async function GET(req: NextRequest) {
  const tier = req.nextUrl.searchParams.get("tier") as "risingwave" | "timescaledb" | "athena" | "influxdb" | null;
  // #253: cloud-analytics is now ONE shared instance for every slot — every
  // read is scoped to the caller's own slot via `?did=` (the same param the
  // browser's workshop/javascripts/deployment-id.js already persists), not a
  // per-release env var. Falls back to WORKSHOP_DEPLOYMENT_ID (the pre-#253
  // per-slot env var) only so a request with no `did` still resolves to
  // *something* rather than silently querying an empty deployment_id.
  const deploymentId = req.nextUrl.searchParams.get("did") ?? process.env.WORKSHOP_DEPLOYMENT_ID ?? "";

  if (tier === "risingwave") {
    const endpoint = process.env.RISINGWAVE_ENDPOINT;
    if (!endpoint) return NextResponse.json(mockPayload("risingwave"));

    try {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: endpoint, connectionTimeoutMillis: 5000 });
      const payload = await queryRisingWaveFreshness(pool, deploymentId);
      await pool.end();
      return NextResponse.json(payload);
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
  }

  if (tier === "timescaledb") {
    const endpoint = process.env.TIMESCALEDB_ENDPOINT;
    if (!endpoint) return NextResponse.json(mockPayload("timescaledb"));

    try {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: endpoint, connectionTimeoutMillis: 5000 });
      const payload = await queryTimescaleDbFreshness(pool, deploymentId);
      await pool.end();
      return NextResponse.json(payload);
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
  }

  if (tier === "athena") {
    // The Iceberg tier: telemetry landed in S3 and registered in the Glue
    // catalog (workshop_telemetry.telemetry), queried on demand through Athena.
    // This is the deliberately-slow "warehouse" leg of the 3-way comparison —
    // an Athena query takes seconds even when the underlying data is recent, so
    // the freshness number reflects query latency + landing lag, not a live push.
    // Falls back to mock when ATHENA_DATABASE is unset (e.g. local dev). Athena
    // has no push/subscribe primitive, so this tier is always polled on demand
    // by the browser — see #160.
    const database = process.env.ATHENA_DATABASE;
    if (!database) return NextResponse.json(mockPayload("athena"));

    const workgroup = process.env.ATHENA_WORKGROUP ?? "workshop-shared";
    const table = process.env.ATHENA_TABLE ?? "telemetry";
    const region = process.env.AWS_REGION ?? "us-east-1";
    // Scope to the caller's slot via `?did=` (see deploymentId above) — the
    // Iceberg table is shared across slots and partitioned by deployment_id.

    try {
      const {
        AthenaClient,
        StartQueryExecutionCommand,
        GetQueryExecutionCommand,
        GetQueryResultsCommand,
      } = await import("@aws-sdk/client-athena");

      const athena = new AthenaClient({ region });
      const now = Date.now();
      // Query latency for the warehouse tier is the full submit → poll → fetch
      // round-trip, so it's seconds — the deliberately-slow read path in the
      // comparison. Measured from just before StartQueryExecution.
      const queryT0 = Date.now();

      const whereClause = deploymentId
        ? `WHERE deployment_id = '${deploymentId.replace(/'/g, "''")}'`
        : "";

      // message_timestamp is epoch-ms (see job-scripts/telemetry-v*.sh), same
      // basis as ts_ms in the other tiers — so the freshness numbers compare
      // apples-to-apples. cpu_pct / mem_used_pct are percentages; free = 100 - used.
      const sql = `
        SELECT
          thing_name AS site_id,
          MAX(message_timestamp)              AS latest_ts_ms,
          AVG(100.0 - CAST(cpu_pct AS double))      AS avg_free_cpu_pct,
          AVG(100.0 - CAST(mem_used_pct AS double)) AS avg_free_mem_pct
        FROM ${database}.${table}
        ${whereClause}
        GROUP BY thing_name
        ORDER BY thing_name
      `;

      const { QueryExecutionId } = await athena.send(
        new StartQueryExecutionCommand({
          QueryString: sql,
          WorkGroup: workgroup,
        })
      );

      // Poll for completion (Athena is async). Cap the wait so a slow query
      // can't hang the dashboard poll — return a null freshness instead.
      const deadline = Date.now() + 30_000;
      let state = "QUEUED";
      while (Date.now() < deadline) {
        const { QueryExecution } = await athena.send(
          new GetQueryExecutionCommand({ QueryExecutionId })
        );
        state = QueryExecution?.Status?.State ?? "UNKNOWN";
        if (state === "SUCCEEDED") break;
        if (state === "FAILED" || state === "CANCELLED") {
          const reason = QueryExecution?.Status?.StateChangeReason ?? state;
          return NextResponse.json({ error: `Athena query ${state}: ${reason}` }, { status: 500 });
        }
        await new Promise(r => setTimeout(r, 750));
      }
      if (state !== "SUCCEEDED") {
        return NextResponse.json({ error: `Athena query timed out (state: ${state})` }, { status: 504 });
      }

      const { ResultSet } = await athena.send(
        new GetQueryResultsCommand({ QueryExecutionId })
      );

      // Row 0 is the column header; skip it. Column order matches the SELECT.
      const dataRows = (ResultSet?.Rows ?? []).slice(1);
      const parsed = dataRows.map(row => {
        const cells = row.Data ?? [];
        return {
          site_id: cells[0]?.VarCharValue ?? "unknown",
          latest_ts_ms: cells[1]?.VarCharValue ? Number(cells[1].VarCharValue) : 0,
          avg_free_cpu_pct: cells[2]?.VarCharValue != null ? parseFloat(cells[2].VarCharValue) : null,
          avg_free_mem_pct: cells[3]?.VarCharValue != null ? parseFloat(cells[3].VarCharValue) : null,
        };
      });

      const latestTs = parsed.length > 0 ? Math.max(...parsed.map(r => r.latest_ts_ms)) : 0;
      const avgFreeCpu = parsed.length > 0
        ? parsed.reduce((s, r) => s + (r.avg_free_cpu_pct ?? 0), 0) / parsed.length
        : null;
      const avgFreeMem = parsed.length > 0
        ? parsed.reduce((s, r) => s + (r.avg_free_mem_pct ?? 0), 0) / parsed.length
        : null;

      const payload: FreshnessPayload = {
        tierFreshness: {
          risingwave_ms: null,
          timescaledb_ms: null,
          athena_ms: latestTs > 0 ? now - latestTs : null,
          influxdb_ms: null,
        },
        tierLatency: {
          risingwave_ms: null,
          timescaledb_ms: null,
          athena_ms: Date.now() - queryT0,
          influxdb_ms: null,
        },
        deviceHopLatency: {
          risingwave_ms: null,
          timescaledb_ms: null,
          athena_ms: null,
          influxdb_ms: null,
        },
        fleetResources: {
          avg_free_cpu_pct: avgFreeCpu,
          avg_free_mem_pct: avgFreeMem,
        },
        nodeAge: parsed
          .filter(r => r.latest_ts_ms > 0)
          .map(r => ({ site_id: r.site_id, age_seconds: (now - r.latest_ts_ms) / 1000 })),
        source: "athena",
        sampled_at: now,
      };
      return NextResponse.json(payload);
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
  }

  if (tier === "influxdb") {
    // The managed hot-tier: Amazon Timestream for InfluxDB, fed by Telegraf off
    // the SAME MSK topics as TimescaleDB (#230). Its counterpart to the
    // self-managed TimescaleDB-on-EKS leg — same freshness basis (ts_ms), so the
    // numbers compare apples-to-apples. InfluxDB has no subscribe primitive we
    // use here, so this tier is polled on demand (like Athena). Falls back to
    // mock when INFLUXDB_ENDPOINT is unset (local dev / telegraf disabled).
    const endpoint = process.env.INFLUXDB_ENDPOINT;
    const token = process.env.INFLUXDB_TOKEN;
    const org = process.env.INFLUXDB_ORG;
    const bucket = process.env.INFLUXDB_BUCKET;
    if (!endpoint || !token || !org || !bucket) {
      return NextResponse.json(mockPayload("influxdb"));
    }

    try {
      const { InfluxDB } = await import("@influxdata/influxdb-client");
      const queryApi = new InfluxDB({ url: endpoint, token }).getQueryApi(org);
      const now = Date.now();
      const queryT0 = Date.now();

      // Latest point per (site_id, sensor) over the last 15m — enough to compute
      // freshness (now − MAX(ts)), per-node age, and fleet free CPU/mem, all off
      // the one dimensional sensor_reading schema Telegraf writes (see #230).
      // #253: the bucket now holds every slot's points in one shared instance
      // (helm/cloud-analytics/templates/telegraf-config.yaml tags each point
      // with deployment_id) — filter on the caller's own slot via `?did=`.
      const fluxDeploymentId = deploymentId.replace(/["\\]/g, "\\$&");
      const flux = `
        from(bucket: "${bucket}")
          |> range(start: -15m)
          |> filter(fn: (r) => r._measurement == "sensor_reading" and r._field == "value" and r.deployment_id == "${fluxDeploymentId}")
          |> group(columns: ["site_id", "sensor"])
          |> last()
      `;

      type Row = { site_id?: string; sensor?: string; _value?: number; _time?: string };
      const rows: Row[] = await queryApi.collectRows(flux);
      const queryMs = Date.now() - queryT0;

      // Freshness = now − newest point across all series.
      let latestTs = 0;
      // Per-node latest timestamp (age) keyed by site_id.
      const nodeLatest = new Map<string, number>();
      // Fleet free CPU/mem: free = 100 − used, averaged across nodes.
      const cpuFree: number[] = [];
      const memFree: number[] = [];

      for (const r of rows) {
        const tsMs = r._time ? Date.parse(r._time) : 0;
        if (tsMs > latestTs) latestTs = tsMs;
        const site = r.site_id ?? "unknown";
        if (tsMs > (nodeLatest.get(site) ?? 0)) nodeLatest.set(site, tsMs);
        if (typeof r._value === "number") {
          if (r.sensor === "cpu_pct") cpuFree.push(100 - r._value);
          if (r.sensor === "mem_used_pct") memFree.push(100 - r._value);
        }
      }

      const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

      const payload: FreshnessPayload = {
        tierFreshness: {
          risingwave_ms: null,
          timescaledb_ms: null,
          athena_ms: null,
          influxdb_ms: latestTs > 0 ? now - latestTs : null,
        },
        tierLatency: {
          risingwave_ms: null,
          timescaledb_ms: null,
          athena_ms: null,
          influxdb_ms: queryMs,
        },
        deviceHopLatency: {
          risingwave_ms: null,
          timescaledb_ms: null,
          athena_ms: null,
          influxdb_ms: null,
        },
        fleetResources: {
          avg_free_cpu_pct: avg(cpuFree),
          avg_free_mem_pct: avg(memFree),
        },
        nodeAge: [...nodeLatest.entries()]
          .filter(([, ts]) => ts > 0)
          .map(([site_id, ts]) => ({ site_id, age_seconds: (now - ts) / 1000 }))
          .sort((a, b) => a.site_id.localeCompare(b.site_id)),
        source: "influxdb",
        sampled_at: now,
      };
      return NextResponse.json(payload);
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "tier param must be risingwave, timescaledb, athena, or influxdb" }, { status: 400 });
}
