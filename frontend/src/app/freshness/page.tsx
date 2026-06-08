"use client";

import { useEffect, useState } from "react";

interface FreshnessRow {
  thing_name: string;
  latest_ts: number;
  freshness_seconds: number;
}

interface Panel {
  label: string;
  tier: "risingwave" | "timescaledb" | "hudi";
  rows: FreshnessRow[];
  error?: string;
  loading: boolean;
}

export default function FreshnessPage() {
  const [risingwave, setRisingwave] = useState<Panel>({
    label: "RisingWave (in-memory MV)",
    tier: "risingwave",
    rows: [],
    loading: true,
  });
  const [timescale, setTimescale] = useState<Panel>({
    label: "TimescaleDB (disk-backed hypertable)",
    tier: "timescaledb",
    rows: [],
    loading: true,
  });

  const fetchTier = async (tier: "risingwave" | "timescaledb") => {
    try {
      const res = await fetch(`/api/freshness?tier=${tier}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const setter = tier === "risingwave" ? setRisingwave : setTimescale;
      setter((p) => ({ ...p, rows: data.rows, loading: false, error: undefined }));
    } catch (e: any) {
      const setter = tier === "risingwave" ? setRisingwave : setTimescale;
      setter((p) => ({ ...p, loading: false, error: e.message }));
    }
  };

  useEffect(() => {
    fetchTier("risingwave");
    fetchTier("timescaledb");
    const iv = setInterval(() => {
      fetchTier("risingwave");
      fetchTier("timescaledb");
    }, 5_000);
    return () => clearInterval(iv);
  }, []);

  const renderPanel = (panel: Panel) => (
    <div className="card" key={panel.tier}>
      <h2 style={{ marginBottom: "0.75rem", fontSize: "1rem" }}>{panel.label}</h2>
      {panel.loading && <p>Loading…</p>}
      {panel.error && <p style={{ color: "red" }}>Error: {panel.error}</p>}
      {!panel.loading && !panel.error && (
        <table>
          <thead>
            <tr>
              <th>Device</th>
              <th>Latest timestamp</th>
              <th>Freshness (s)</th>
            </tr>
          </thead>
          <tbody>
            {panel.rows.map((r) => (
              <tr key={r.thing_name}>
                <td>{r.thing_name}</td>
                <td>{new Date(r.latest_ts).toISOString()}</td>
                <td
                  style={{
                    fontWeight: "bold",
                    color: r.freshness_seconds < 5 ? "#28a745" : r.freshness_seconds < 30 ? "#fd7e14" : "#dc3545",
                  }}
                >
                  {r.freshness_seconds.toFixed(1)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );

  return (
    <div className="page">
      <h1 className="page-title">Data Freshness Comparison</h1>
      <p style={{ marginBottom: "1.5rem", color: "#666", fontSize: "0.9rem" }}>
        Refreshes every 5 seconds. Hudi/Athena freshness is measured in the Athena console (30–90 s floor).
      </p>
      {renderPanel(risingwave)}
      {renderPanel(timescale)}
      <div className="card">
        <h2 style={{ marginBottom: "0.5rem", fontSize: "1rem" }}>Hudi / Athena (archive tier)</h2>
        <p style={{ color: "#666", fontSize: "0.9rem" }}>
          No browser-native Hudi client exists. Query directly in the Athena console:
        </p>
        <pre style={{ background: "#f8f9fa", padding: "1rem", borderRadius: "4px", fontSize: "0.82rem", marginTop: "0.75rem", overflowX: "auto" }}>
{`SELECT
  thing_name,
  MAX(message_timestamp)     AS latest_edge_ts,
  current_timestamp          AS query_ts,
  date_diff('second',
    MAX(message_timestamp),
    current_timestamp)       AS freshness_seconds
FROM "workshop_{deployment_id}"."telemetry"
GROUP BY thing_name
ORDER BY freshness_seconds DESC;`}
        </pre>
        <p style={{ marginTop: "0.75rem", color: "#888", fontSize: "0.82rem" }}>
          Expected freshness floor: <strong>30–90 s</strong> (MSK Connect flush interval + Hudi delta log commit).
        </p>
      </div>
    </div>
  );
}
