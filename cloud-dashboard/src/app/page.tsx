"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from "recharts";
import type { FreshnessPayload } from "./api/freshness/route";

// ── colour palette ────────────────────────────────────────────────────────────
const COLOUR_RW     = "#6366f1"; // indigo — RisingWave
const COLOUR_TSDB   = "#10b981"; // emerald — TimescaleDB
const COLOUR_ATHENA = "#f59e0b"; // amber — Athena
const COLOUR_INFLUX = "#06b6d4"; // cyan — Timestream for InfluxDB
const COLOUR_CPU    = "#3b82f6"; // blue
const COLOUR_MEM    = "#a855f7"; // purple

// ── chart 1: freshness (log scale) ───────────────────────────────────────────
// recharts doesn't support log scale natively, so we store log10 values and
// format the tick/tooltip labels back to ms.

function logVal(ms: number | null): number | null {
  return ms != null && ms > 0 ? Math.log10(ms) : null;
}

function msLabel(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

const LOG_TICKS = [1, 10, 100, 1_000, 10_000, 100_000]; // ms
const logTickFormatter = (v: number) => msLabel(Math.pow(10, v));

interface FreshnessBarDatum {
  tier: string;
  rw: number | null;
  tsdb: number | null;
  athena: number | null;
  influx: number | null;
}

// A single log-scale grouped bar chart of a per-tier ms metric. Shared by the
// freshness chart (data staleness) and the query-latency chart (read-path cost)
// — same four tiers, same log axis, different metric.
function TierMsBarChart({
  title, blurb, axisLabel, rw, tsdb, athena, influx,
}: {
  title: string; blurb: string; axisLabel: string;
  rw: number | null; tsdb: number | null; athena: number | null; influx: number | null;
}) {
  const chartData: FreshnessBarDatum[] = [
    { tier: "RisingWave",  rw: logVal(rw),  tsdb: null,          athena: null,           influx: null           },
    { tier: "TimescaleDB", rw: null,        tsdb: logVal(tsdb),  athena: null,           influx: null           },
    { tier: "InfluxDB",    rw: null,        tsdb: null,          athena: null,           influx: logVal(influx) },
    { tier: "Athena/S3",   rw: null,        tsdb: null,          athena: logVal(athena), influx: null           },
  ];

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    const ms = Math.pow(10, payload[0]?.value ?? 0);
    return (
      <div style={{ background: "#1e293b", border: "1px solid #334155", padding: "8px 12px", borderRadius: 6, fontSize: 13 }}>
        <p style={{ margin: 0, color: "#94a3b8" }}>{label}</p>
        <p style={{ margin: "4px 0 0", color: "#f8fafc", fontWeight: 600 }}>{msLabel(ms)}</p>
      </div>
    );
  };

  return (
    <div className="card">
      <h2 style={{ marginBottom: "0.25rem", fontSize: "1rem" }}>{title}</h2>
      <p style={{ color: "#888", fontSize: "0.8rem", marginBottom: "0.75rem" }}>{blurb}</p>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={chartData} margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis dataKey="tier" tick={{ fill: "#94a3b8", fontSize: 12 }} />
          <YAxis
            tickFormatter={logTickFormatter}
            ticks={LOG_TICKS.map(v => Math.log10(v))}
            domain={[0, Math.log10(100_000)]}
            tick={{ fill: "#94a3b8", fontSize: 11 }}
            label={{ value: axisLabel, angle: -90, position: "insideLeft", fill: "#64748b", fontSize: 11 }}
          />
          <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(255,255,255,0.05)" }} />
          <Bar dataKey="rw"     name="RisingWave"  fill={COLOUR_RW}     radius={[4,4,0,0]} />
          <Bar dataKey="tsdb"   name="TimescaleDB" fill={COLOUR_TSDB}   radius={[4,4,0,0]} />
          <Bar dataKey="influx" name="InfluxDB"    fill={COLOUR_INFLUX} radius={[4,4,0,0]} />
          <Bar dataKey="athena" name="Athena/S3"   fill={COLOUR_ATHENA} radius={[4,4,0,0]} />
        </BarChart>
      </ResponsiveContainer>
      <div style={{ display: "flex", gap: "1.5rem", marginTop: "0.5rem", fontSize: "0.85rem", color: "#94a3b8", flexWrap: "wrap" }}>
        <span><span style={{ color: COLOUR_RW,     fontWeight: 600 }}>● </span>RisingWave: {msLabel(rw)}</span>
        <span><span style={{ color: COLOUR_TSDB,   fontWeight: 600 }}>● </span>TimescaleDB: {msLabel(tsdb)}</span>
        <span><span style={{ color: COLOUR_INFLUX, fontWeight: 600 }}>● </span>InfluxDB: {msLabel(influx)}</span>
        <span><span style={{ color: COLOUR_ATHENA, fontWeight: 600 }}>● </span>Athena: {msLabel(athena)}</span>
      </div>
    </div>
  );
}

// ── chart 1b: query latency (log scale) ──────────────────────────────────────
// Read-path cost per tier — the metric where RisingWave's pre-aggregated
// in-memory MV is expected to beat TimescaleDB's relational scan, and both beat
// Athena's warehouse round-trip. Orthogonal to freshness (data staleness).
function LatencyChart({ rw, tsdb, athena, influx }: { rw: FreshnessPayload | null; tsdb: FreshnessPayload | null; athena: FreshnessPayload | null; influx: FreshnessPayload | null }) {
  return (
    <TierMsBarChart
      title="Query Latency (log scale)"
      blurb="Wall-clock time to run each tier's read query. Lower is better. This is the read-path cost — in-memory MV vs relational scan vs managed-TSDB query vs warehouse round-trip — independent of how stale the data is."
      axisLabel="latency (log)"
      rw={rw?.tierLatency.risingwave_ms ?? null}
      tsdb={tsdb?.tierLatency.timescaledb_ms ?? null}
      athena={athena?.tierLatency.athena_ms ?? null}
      influx={influx?.tierLatency.influxdb_ms ?? null}
    />
  );
}

// ── push hook: subscribe to /api/stream/{tier} over SSE ──────────────────────
// Replaces the old setInterval poll for the two live tiers (#160). The server
// holds a RisingWave subscription cursor or a TimescaleDB LISTEN connection
// and pushes a new FreshnessPayload every time the underlying store changes —
// there is no fixed interval on this side, updates arrive as fast as the
// store produces them.
function usePushFreshness(tier: "risingwave" | "timescaledb") {
  const [data, setData] = useState<FreshnessPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const es = new EventSource(`/api/stream/${tier}`);
    es.addEventListener("freshness", (evt: MessageEvent) => {
      try {
        setData(JSON.parse(evt.data));
        setError(null);
      } catch {
        // ignore malformed event
      }
    });
    // #210: the server sends this instead of silently doing nothing when a
    // connect/query error occurs, so a transient blip is visible rather than
    // an indefinite "—".
    es.addEventListener("tier-error", (evt: MessageEvent) => {
      try {
        const { message } = JSON.parse(evt.data);
        setError(message ?? "tier error");
      } catch {
        setError("tier error");
      }
    });
    es.onerror = () => setError("stream disconnected");
    return () => es.close();
  }, [tier]);

  return { data, error };
}

// ── poll hook: Athena (on-demand warehouse query) and InfluxDB (managed TSDB,
// no subscribe primitive we use here) have no push path, so they stay on
// setInterval (#160 keeps Athena as-is; #231 adds InfluxDB the same way).
function usePolledFreshness(tier: "athena" | "influxdb", intervalMs: number) {
  const [data, setData] = useState<FreshnessPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/freshness?tier=${tier}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: FreshnessPayload = await res.json();
        if (!cancelled) { setData(json); setError(null); }
      } catch (e: any) {
        if (!cancelled) setError(e.message);
      }
    };
    poll();
    const id = setInterval(poll, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [tier, intervalMs]);

  return { data, error };
}

// ── chart 1 component ─────────────────────────────────────────────────────────
// Data freshness = now − MAX(ts): how stale the newest row is (ingestion-lag,
// not read cost). See LatencyChart for the orthogonal read-path metric.
function FreshnessChart({ rw, tsdb, athena, influx }: { rw: FreshnessPayload | null; tsdb: FreshnessPayload | null; athena: FreshnessPayload | null; influx: FreshnessPayload | null }) {
  return (
    <TierMsBarChart
      title="Data Freshness (log scale)"
      blurb="How stale is the most recent message in each store. Lower is better. RisingWave and TimescaleDB update by push; InfluxDB and Athena update on their own poll cadence."
      axisLabel="staleness (log)"
      rw={rw?.tierFreshness.risingwave_ms ?? null}
      tsdb={tsdb?.tierFreshness.timescaledb_ms ?? null}
      athena={athena?.tierFreshness.athena_ms ?? null}
      influx={influx?.tierFreshness.influxdb_ms ?? null}
    />
  );
}

// ── chart 2 component ─────────────────────────────────────────────────────────
function ResourceChart({ rw, tsdb }: { rw: FreshnessPayload | null; tsdb: FreshnessPayload | null }) {
  const chartData = [
    {
      name: "RisingWave",
      cpu: rw?.fleetResources.avg_free_cpu_pct ?? null,
      mem: rw?.fleetResources.avg_free_mem_pct ?? null,
    },
    {
      name: "TimescaleDB",
      cpu: tsdb?.fleetResources.avg_free_cpu_pct ?? null,
      mem: tsdb?.fleetResources.avg_free_mem_pct ?? null,
    },
  ];

  const pctLabel = (v: number | null) => v != null ? `${v.toFixed(1)}%` : "—";

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    return (
      <div style={{ background: "#1e293b", border: "1px solid #334155", padding: "8px 12px", borderRadius: 6, fontSize: 13 }}>
        <p style={{ margin: 0, color: "#94a3b8" }}>{label}</p>
        {payload.map((p: any) => (
          <p key={p.name} style={{ margin: "4px 0 0", color: p.fill, fontWeight: 600 }}>
            {p.name}: {pctLabel(p.value)}
          </p>
        ))}
      </div>
    );
  };

  return (
    <div className="card">
      <h2 style={{ marginBottom: "0.25rem", fontSize: "1rem" }}>Fleet Free CPU &amp; Memory</h2>
      <p style={{ color: "#888", fontSize: "0.8rem", marginBottom: "0.75rem" }}>
        Average across all nodes, as seen by each database. Higher is better.
      </p>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={chartData} margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis dataKey="name" tick={{ fill: "#94a3b8", fontSize: 12 }} />
          <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fill: "#94a3b8", fontSize: 11 }} />
          <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(255,255,255,0.05)" }} />
          <Legend wrapperStyle={{ fontSize: 12, color: "#94a3b8" }} />
          <Bar dataKey="cpu" name="Free CPU" fill={COLOUR_CPU}  radius={[4,4,0,0]} />
          <Bar dataKey="mem" name="Free Mem" fill={COLOUR_MEM}  radius={[4,4,0,0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── chart 3 component ─────────────────────────────────────────────────────────
function NodeAgeChart({ rw, tsdb }: { rw: FreshnessPayload | null; tsdb: FreshnessPayload | null }) {
  // Merge the two node lists — same site_ids, different age values
  const siteIds = Array.from(new Set([
    ...(rw?.nodeAge ?? []).map(n => n.site_id),
    ...(tsdb?.nodeAge ?? []).map(n => n.site_id),
  ])).sort();

  const chartData = siteIds.map(id => ({
    site_id: id.replace(/^ws-slot\d+-/, ""), // shorten label
    rw_age:   rw?.nodeAge.find(n => n.site_id === id)?.age_seconds  ?? null,
    tsdb_age: tsdb?.nodeAge.find(n => n.site_id === id)?.age_seconds ?? null,
  }));

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    return (
      <div style={{ background: "#1e293b", border: "1px solid #334155", padding: "8px 12px", borderRadius: 6, fontSize: 13 }}>
        <p style={{ margin: 0, color: "#94a3b8" }}>{label}</p>
        {payload.map((p: any) => (
          <p key={p.name} style={{ margin: "4px 0 0", color: p.fill, fontWeight: 600 }}>
            {p.name}: {p.value != null ? `${p.value.toFixed(2)}s` : "—"}
          </p>
        ))}
      </div>
    );
  };

  return (
    <div className="card">
      <h2 style={{ marginBottom: "0.25rem", fontSize: "1rem" }}>Time Since Last Message — Per Node</h2>
      <p style={{ color: "#888", fontSize: "0.8rem", marginBottom: "0.75rem" }}>
        Seconds since the most recent reading from each node, as seen by RisingWave vs TimescaleDB.
      </p>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={chartData} margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis dataKey="site_id" tick={{ fill: "#94a3b8", fontSize: 11 }} />
          <YAxis tickFormatter={(v) => `${v}s`} tick={{ fill: "#94a3b8", fontSize: 11 }} />
          <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(255,255,255,0.05)" }} />
          <Legend wrapperStyle={{ fontSize: 12, color: "#94a3b8" }} />
          <Bar dataKey="rw_age"   name="RisingWave"  fill={COLOUR_RW}   radius={[4,4,0,0]} />
          <Bar dataKey="tsdb_age" name="TimescaleDB" fill={COLOUR_TSDB} radius={[4,4,0,0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── latency map (#205) ───────────────────────────────────────────────────────
// Architecture-style diagram: edge → store → dashboard, one lane per tier,
// annotated with the same two hop numbers the bar charts above already
// compute — never re-derived here, so the map can't disagree with them.
// Hop 1 ("ingest lag") is tierFreshness: now minus the newest row's
// ingest-stamped ts_ms — everything upstream of the store (device → MQTT →
// pipeline → write). Hop 2 ("query") is tierLatency: wall-clock to read the
// store from this dashboard. Per #206, freshness must never come from a
// database's own now() (RisingWave's included) — tierFreshness already
// satisfies that (see lib/freshness-queries.ts), so reusing it here can't
// regress that constraint.
function HopArrow({ label, ms, color }: { label: string; ms: number | null; color: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1, minWidth: 110 }}>
      <div style={{ fontSize: "0.68rem", color: "#64748b", marginBottom: 2, textAlign: "center" }}>{label}</div>
      <div style={{ width: "100%", display: "flex", alignItems: "center" }}>
        <div style={{ flex: 1, height: 2, background: color, opacity: 0.5 }} />
        <div style={{ fontSize: "0.72rem", color: "#e2e8f0", fontWeight: 600, padding: "0 6px", whiteSpace: "nowrap" }}>
          {msLabel(ms)}
        </div>
        <div style={{ flex: 1, height: 2, background: color, opacity: 0.5 }} />
      </div>
    </div>
  );
}

function LatencyMapNode({ children, accent }: { children: ReactNode; accent?: string }) {
  return (
    <div style={{
      border: `1px solid ${accent ?? "#334155"}`,
      borderRadius: 8,
      padding: "0.5rem 0.75rem",
      fontSize: "0.78rem",
      color: "#e2e8f0",
      background: "#0f172a",
      whiteSpace: "nowrap",
      textAlign: "center",
      minWidth: 96,
      flexShrink: 0,
    }}>
      {children}
    </div>
  );
}

function LatencyMapRow({
  label, color, storeLabel, ingestMs, queryMs, pushMode,
}: {
  label: string; color: string; storeLabel: string;
  ingestMs: number | null; queryMs: number | null; pushMode: "push" | "poll";
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.6rem 0", borderTop: "1px solid #1e293b", flexWrap: "wrap" }}>
      <div style={{ width: 100, fontSize: "0.8rem", color, fontWeight: 600, flexShrink: 0 }}>{label}</div>
      <LatencyMapNode>Edge device</LatencyMapNode>
      <HopArrow label="ingest lag" ms={ingestMs} color={color} />
      <LatencyMapNode accent={color}>{storeLabel}</LatencyMapNode>
      <HopArrow label={pushMode === "push" ? "query · live push" : "query · on-demand poll"} ms={queryMs} color={color} />
      <LatencyMapNode>Dashboard</LatencyMapNode>
    </div>
  );
}

function LatencyMap({ rw, tsdb, athena, influx }: { rw: FreshnessPayload | null; tsdb: FreshnessPayload | null; athena: FreshnessPayload | null; influx: FreshnessPayload | null }) {
  return (
    <div className="card">
      <h2 style={{ marginBottom: "0.25rem", fontSize: "1rem" }}>Edge → Cloud Latency Map</h2>
      <p style={{ color: "#888", fontSize: "0.8rem", marginBottom: "0.75rem" }}>
        The same freshness/latency numbers as the charts above, laid out along each tier&apos;s path: how stale the newest row is by the time it lands in the store (ingest lag), then how long that store takes to answer the fleet aggregate (query).
      </p>
      <LatencyMapRow
        label="RisingWave" color={COLOUR_RW} storeLabel="RisingWave MV" pushMode="push"
        ingestMs={rw?.tierFreshness.risingwave_ms ?? null}
        queryMs={rw?.tierLatency.risingwave_ms ?? null}
      />
      <LatencyMapRow
        label="TimescaleDB" color={COLOUR_TSDB} storeLabel="TimescaleDB CAGG" pushMode="push"
        ingestMs={tsdb?.tierFreshness.timescaledb_ms ?? null}
        queryMs={tsdb?.tierLatency.timescaledb_ms ?? null}
      />
      <LatencyMapRow
        label="InfluxDB" color={COLOUR_INFLUX} storeLabel="Timestream InfluxDB" pushMode="poll"
        ingestMs={influx?.tierFreshness.influxdb_ms ?? null}
        queryMs={influx?.tierLatency.influxdb_ms ?? null}
      />
      <LatencyMapRow
        label="Athena/S3" color={COLOUR_ATHENA} storeLabel="Iceberg/Athena" pushMode="poll"
        ingestMs={athena?.tierFreshness.athena_ms ?? null}
        queryMs={athena?.tierLatency.athena_ms ?? null}
      />
    </div>
  );
}

// ── pulse indicator ───────────────────────────────────────────────────────────
function Pulse({ active }: { active: boolean }) {
  return (
    <span style={{
      display: "inline-block", width: 8, height: 8, borderRadius: "50%",
      background: active ? "#22c55e" : "#475569",
      boxShadow: active ? "0 0 6px #22c55e" : "none",
      marginRight: 6,
      transition: "background 0.3s, box-shadow 0.3s",
    }} />
  );
}

// ── page ──────────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const { data: rwData,   error: rwError   } = usePushFreshness("risingwave");
  const { data: tsdbData, error: tsdbError } = usePushFreshness("timescaledb");
  // Athena/Iceberg is the slow warehouse tier — a query takes seconds, and it
  // has no push/subscribe primitive, so it stays on a slow poll (#160).
  const { data: athenaData, error: athenaError } = usePolledFreshness("athena", 15000);
  // Timestream for InfluxDB is a managed hot store fed by Telegraf off the same
  // MSK topics (#230). No subscribe primitive we use here, so it polls like
  // Athena — but it's a fast time-series read, so a tighter 5s cadence (#231).
  const { data: influxData, error: influxError } = usePolledFreshness("influxdb", 5000);

  const isMock = rwData?.source === "mock" || tsdbData?.source === "mock" || athenaData?.source === "mock" || influxData?.source === "mock";

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.5rem", flexWrap: "wrap", gap: "0.5rem" }}>
        <h1 className="page-title" style={{ margin: 0 }}>Cloud Analytics Dashboard</h1>
        <div style={{ display: "flex", gap: "1rem", fontSize: "0.82rem", color: "#94a3b8" }}>
          <span><Pulse active={!rwError && rwData != null} />RisingWave {rwError ? `(${rwError})` : rwData?.source === "mock" ? "(mock)" : "live · push"}</span>
          <span><Pulse active={!tsdbError && tsdbData != null} />TimescaleDB {tsdbError ? `(${tsdbError})` : tsdbData?.source === "mock" ? "(mock)" : "live · push"}</span>
          <span><Pulse active={!influxError && influxData != null} />InfluxDB {influxError ? `(${influxError})` : influxData?.source === "mock" ? "(mock)" : "live · poll"}</span>
          <span><Pulse active={!athenaError && athenaData != null} />Athena {athenaError ? `(${athenaError})` : athenaData?.source === "mock" ? "(mock)" : "live · poll"}</span>
          {isMock && (
            <span style={{ color: "#f59e0b" }}>
              ⚠ Mock data — set RISINGWAVE_ENDPOINT, TIMESCALEDB_ENDPOINT, ATHENA_DATABASE, and INFLUXDB_ENDPOINT env vars to connect to live sources
            </span>
          )}
        </div>
      </div>

      <FreshnessChart  rw={rwData}   tsdb={tsdbData} athena={athenaData} influx={influxData} />
      <div style={{ height: "1rem" }} />
      <LatencyChart    rw={rwData}   tsdb={tsdbData} athena={athenaData} influx={influxData} />
      <div style={{ height: "1rem" }} />
      <ResourceChart   rw={rwData}   tsdb={tsdbData} />
      <div style={{ height: "1rem" }} />
      <NodeAgeChart    rw={rwData}   tsdb={tsdbData} />
      <div style={{ height: "1rem" }} />
      <LatencyMap      rw={rwData}   tsdb={tsdbData} athena={athenaData} influx={influxData} />
    </div>
  );
}
