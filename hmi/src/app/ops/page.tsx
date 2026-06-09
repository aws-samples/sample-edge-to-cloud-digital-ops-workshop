"use client";

import { useCallback, useEffect, useState } from "react";
import type { SensorStats } from "../api/digital-ops/route";

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
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/digital-ops");
      const json: ApiResponse = await res.json();
      setData(json);
      setLastRefresh(new Date());
    } catch (err) {
      setData({ stats: [], queryDurationMs: 0, error: String(err) });
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

      {/* WAN relay placeholder */}
      <div style={cardStyle}>
        <h2>WAN Relay Lag</h2>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Stream</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Lag (ms)</th>
              <th style={thStyle}>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={tdStyle}>Edge → Cloud MSK</td>
              <td
                style={{ ...tdStyle, textAlign: "right", color: "#8b949e" }}
              >
                N/A
              </td>
              <td style={{ ...tdStyle, color: "#8b949e" }}>
                N/A — connect to cloud MSK to see lag
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
