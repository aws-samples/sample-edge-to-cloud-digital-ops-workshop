"use client";

import { useEffect, useRef, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, Cell,
} from "recharts";
import type { FreshnessPayload } from "../api/freshness/route";

// ── colour palette ────────────────────────────────────────────────────────────
const COLOUR_RW     = "#6366f1"; // indigo — RisingWave
const COLOUR_TSDB   = "#10b981"; // emerald — TimescaleDB
const COLOUR_ATHENA = "#f59e0b"; // amber — Athena
const COLOUR_CPU    = "#3b82f6"; // blue
const COLOUR_MEM    = "#a855f7"; // purple
const NODE_COLOURS  = ["#06b6d4", "#22c55e", "#f97316", "#ec4899", "#8b5cf6"];

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
}

// ── shared hook: poll /api/freshness every N ms ───────────────────────────────
function useFreshness(tier: "risingwave" | "timescaledb", intervalMs = 3000) {
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
function FreshnessChart({ rw, tsdb }: { rw: FreshnessPayload | null; tsdb: FreshnessPayload | null }) {
  // We keep a rolling 30-point history so the chart scrolls like a time series.
  const historyRef = useRef<Array<{ t: number; rw_ms: number | null; tsdb_ms: number | null; athena_ms: number | null }>>([]);

  const rwMs   = rw?.tierFreshness.risingwave_ms   ?? null;
  const tsMs   = tsdb?.tierFreshness.timescaledb_ms ?? null;
  // Athena is not polled live — use the last known value from whichever payload has it
  const atMs   = rw?.tierFreshness.athena_ms ?? tsdb?.tierFreshness.athena_ms ?? null;
  const sampledAt = rw?.sampled_at ?? tsdb?.sampled_at ?? Date.now();

  useEffect(() => {
    if (rwMs == null && tsMs == null) return;
    historyRef.current = [
      ...historyRef.current.slice(-29),
      { t: sampledAt, rw_ms: rwMs, tsdb_ms: tsMs, athena_ms: atMs },
    ];
  }, [rwMs, tsMs, atMs, sampledAt]);

  const chartData: FreshnessBarDatum[] = [
    { tier: "RisingWave",  rw: logVal(rwMs),  tsdb: null,         athena: null      },
    { tier: "TimescaleDB", rw: null,           tsdb: logVal(tsMs), athena: null      },
    { tier: "Athena/S3",   rw: null,           tsdb: null,         athena: logVal(atMs) },
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
      <h2 style={{ marginBottom: "0.25rem", fontSize: "1rem" }}>Data Freshness (log scale)</h2>
      <p style={{ color: "#888", fontSize: "0.8rem", marginBottom: "0.75rem" }}>
        How stale is the most recent message in each store. Lower is better.
      </p>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={chartData} margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis dataKey="tier" tick={{ fill: "#94a3b8", fontSize: 12 }} />
          <YAxis
            tickFormatter={logTickFormatter}
            ticks={LOG_TICKS.map(v => Math.log10(v))}
            domain={[0, Math.log10(100_000)]}
            tick={{ fill: "#94a3b8", fontSize: 11 }}
            label={{ value: "latency (log)", angle: -90, position: "insideLeft", fill: "#64748b", fontSize: 11 }}
          />
          <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(255,255,255,0.05)" }} />
          <Bar dataKey="rw"     name="RisingWave"  fill={COLOUR_RW}     radius={[4,4,0,0]} />
          <Bar dataKey="tsdb"   name="TimescaleDB" fill={COLOUR_TSDB}   radius={[4,4,0,0]} />
          <Bar dataKey="athena" name="Athena/S3"   fill={COLOUR_ATHENA} radius={[4,4,0,0]} />
        </BarChart>
      </ResponsiveContainer>
      <div style={{ display: "flex", gap: "1.5rem", marginTop: "0.5rem", fontSize: "0.85rem", color: "#94a3b8" }}>
        <span><span style={{ color: COLOUR_RW,     fontWeight: 600 }}>● </span>RisingWave: {msLabel(rwMs)}</span>
        <span><span style={{ color: COLOUR_TSDB,   fontWeight: 600 }}>● </span>TimescaleDB: {msLabel(tsMs)}</span>
        <span><span style={{ color: COLOUR_ATHENA, fontWeight: 600 }}>● </span>Athena: {msLabel(atMs)}</span>
      </div>
    </div>
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
  const { data: rwData,   error: rwError   } = useFreshness("risingwave",  3000);
  const { data: tsdbData, error: tsdbError } = useFreshness("timescaledb", 3000);

  const [tick, setTick] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setTick(t => !t), 3000);
    return () => clearInterval(id);
  }, []);

  const isMock = rwData?.source === "mock" || tsdbData?.source === "mock";

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.5rem", flexWrap: "wrap", gap: "0.5rem" }}>
        <h1 className="page-title" style={{ margin: 0 }}>Live Analytics Dashboard</h1>
        <div style={{ display: "flex", gap: "1rem", fontSize: "0.82rem", color: "#94a3b8" }}>
          <span><Pulse active={!rwError && rwData != null} />RisingWave {rwError ? `(${rwError})` : rwData?.source === "mock" ? "(mock)" : "live"}</span>
          <span><Pulse active={!tsdbError && tsdbData != null} />TimescaleDB {tsdbError ? `(${tsdbError})` : tsdbData?.source === "mock" ? "(mock)" : "live"}</span>
          {isMock && (
            <span style={{ color: "#f59e0b" }}>
              ⚠ Mock data — set RISINGWAVE_ENDPOINT and TIMESCALEDB_ENDPOINT env vars to connect to live databases
            </span>
          )}
        </div>
      </div>

      <FreshnessChart  rw={rwData}   tsdb={tsdbData} />
      <div style={{ height: "1rem" }} />
      <ResourceChart   rw={rwData}   tsdb={tsdbData} />
      <div style={{ height: "1rem" }} />
      <NodeAgeChart    rw={rwData}   tsdb={tsdbData} />
    </div>
  );
}
