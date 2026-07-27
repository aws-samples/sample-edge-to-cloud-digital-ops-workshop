"use client";

import { useCallback, useEffect, useState } from "react";
import type { SensorStats } from "../api/digital-ops/route";
import type { RelayLagResponse } from "../api/relay-lag/route";

interface ApiResponse {
  stats: SensorStats[];
  queryDurationMs: number;
  error?: string;
}

const SENSOR_UNITS: Record<string, string> = {
  pump_pressure_1: "PSI",
  pump_pressure_2: "PSI",
  pump_pressure_3: "PSI",
  wellhead_pressure: "PSI",
  annular_pressure: "PSI",
  blender_rpm: "RPM",
};

function fmt(v: number | null, digits = 1): string {
  if (v === null) return "—";
  return v.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  borderBottom: "1px solid #30363d",
  color: "#8b949e",
  fontWeight: 500,
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderBottom: "1px solid #21262d",
  fontVariantNumeric: "tabular-nums",
};

export default function OpsPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [relay, setRelay] = useState<RelayLagResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, relayRes] = await Promise.allSettled([
        fetch("/api/digital-ops").then((r) => r.json() as Promise<ApiResponse>),
        fetch("/api/relay-lag").then((r) => r.json() as Promise<RelayLagResponse>),
      ]);
      setData(
        statsRes.status === "fulfilled"
          ? statsRes.value
          : { stats: [], queryDurationMs: 0, error: String(statsRes.reason) }
      );
      setRelay(
        relayRes.status === "fulfilled"
          ? relayRes.value
          : { streams: [], scrapedAt: Date.now(), queryDurationMs: 0, error: String(relayRes.reason) }
      );
      setLastRefresh(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  // Poll every 30 s
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  const cardStyle: React.CSSProperties = {
    background: "#161b22",
    border: "1px solid #30363d",
    borderRadius: 6,
    padding: 16,
    marginBottom: 24,
  };

  const metaStyle: React.CSSProperties = {
    color: "#8b949e",
    fontSize: 12,
    marginTop: 8,
    display: "flex",
    gap: 16,
  };

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 20,
        }}
      >
        <h1 style={{ margin: 0 }}>Digital Ops</h1>
        <button
          onClick={refresh}
          disabled={loading}
          style={{
            padding: "4px 12px",
            background: "#21262d",
            border: "1px solid #30363d",
            borderRadius: 4,
            color: "#e6edf3",
            cursor: loading ? "not-allowed" : "pointer",
            fontSize: 12,
          }}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
        {lastRefresh && (
          <span style={{ color: "#8b949e", fontSize: 12 }}>
            Last refresh: {lastRefresh.toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* Sensor stats table */}
      <div style={cardStyle}>
        <h2>Sensor Statistics — Last 5 Minutes</h2>

        {data?.error && (
          <div
            style={{
              color: "#da3633",
              background: "#1c1c1c",
              border: "1px solid #da3633",
              borderRadius: 4,
              padding: "8px 12px",
              marginBottom: 12,
              fontSize: 12,
            }}
          >
            TimescaleDB error: {data.error}
          </div>
        )}

        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Sensor</th>
              <th style={thStyle}>Unit</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Avg</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Min</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Max</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Samples</th>
            </tr>
          </thead>
          <tbody>
            {!data || data.stats.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  style={{ ...tdStyle, color: "#8b949e", textAlign: "center" }}
                >
                  {loading ? "Loading…" : "No data — is TimescaleDB reachable?"}
                </td>
              </tr>
            ) : (
              data.stats.map((row) => (
                <tr key={row.sensor}>
                  <td style={tdStyle}>
                    <code
                      style={{
                        background: "#21262d",
                        padding: "1px 6px",
                        borderRadius: 3,
                        fontSize: 12,
                      }}
                    >
                      {row.sensor}
                    </code>
                  </td>
                  <td style={{ ...tdStyle, color: "#8b949e" }}>
                    {SENSOR_UNITS[row.sensor] ?? ""}
                  </td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>
                    {fmt(row.avg)}
                  </td>
                  <td style={{ ...tdStyle, textAlign: "right", color: "#238636" }}>
                    {fmt(row.min)}
                  </td>
                  <td style={{ ...tdStyle, textAlign: "right", color: "#e3b341" }}>
                    {fmt(row.max)}
                  </td>
                  <td style={{ ...tdStyle, textAlign: "right", color: "#8b949e" }}>
                    {row.count.toLocaleString()}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {data && (
          <div style={metaStyle}>
            <span>Query: {data.queryDurationMs} ms</span>
            <span>Source: TimescaleDB @ {process.env.NEXT_PUBLIC_TIMESCALE_HOST ?? "timescaledb-rw"}</span>
          </div>
        )}
      </div>

      {/* WAN relay backlog — edge → cloud MSK consumer-group lag */}
      <div style={cardStyle}>
        <h2>WAN Relay Backlog</h2>
        <p style={{ color: "#8b949e", fontSize: 12, marginTop: 0, marginBottom: 12 }}>
          Records buffered on the edge that the relay has not yet forwarded to
          cloud MSK, from the Redpanda consumer-group offset lag. A rising
          backlog means the WAN link is down — the edge keeps ingesting while the
          relay stalls, then drains once connectivity returns.
        </p>

        {relay?.error && (
          <div
            style={{
              color: "#da3633",
              background: "#1c1c1c",
              border: "1px solid #da3633",
              borderRadius: 4,
              padding: "8px 12px",
              marginBottom: 12,
              fontSize: 12,
            }}
          >
            Redpanda metrics error: {relay.error}
          </div>
        )}

        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Consumer group</th>
              <th style={thStyle}>Topic</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Backlog (records)</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Partitions</th>
              <th style={thStyle}>Status</th>
            </tr>
          </thead>
          <tbody>
            {!relay || relay.streams.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  style={{ ...tdStyle, color: "#8b949e", textAlign: "center" }}
                >
                  {loading
                    ? "Loading…"
                    : relay?.error
                    ? "No data — is the edge Redpanda Admin API reachable?"
                    : "No relay consumer group registered yet"}
                </td>
              </tr>
            ) : (
              relay.streams.map((s) => {
                const caughtUp = s.backlog === 0;
                return (
                  <tr key={`${s.group}|${s.topic}`}>
                    <td style={tdStyle}>
                      <code
                        style={{
                          background: "#21262d",
                          padding: "1px 6px",
                          borderRadius: 3,
                          fontSize: 12,
                        }}
                      >
                        {s.group}
                      </code>
                    </td>
                    <td style={{ ...tdStyle, color: "#8b949e" }}>{s.topic}</td>
                    <td
                      style={{
                        ...tdStyle,
                        textAlign: "right",
                        color: caughtUp ? "#238636" : "#e3b341",
                        fontWeight: caughtUp ? 400 : 600,
                      }}
                    >
                      {s.backlog.toLocaleString()}
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right", color: "#8b949e" }}>
                      {s.partitions}
                    </td>
                    <td style={{ ...tdStyle, color: caughtUp ? "#238636" : "#e3b341" }}>
                      {caughtUp ? "Caught up" : "Backlog draining / WAN degraded"}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        {relay && (
          <div style={metaStyle}>
            <span>Scrape: {relay.queryDurationMs} ms</span>
            <span>
              Source: Redpanda /public_metrics @{" "}
              {process.env.NEXT_PUBLIC_REDPANDA_ADMIN_HOST ?? "edge-stack-0:9644"}
            </span>
          </div>
        )}
      </div>
    </>
  );
}
