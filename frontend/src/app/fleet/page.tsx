"use client";

import { useEffect, useState } from "react";
import { fetchAuthSession } from "aws-amplify/auth";

interface DeviceShadow {
  thingName: string;
  connectivity?: { connected: boolean; timestamp?: number };
  deviceConfig?: {
    telemetry_interval_ms?: number;
    metrics?: string[];
    config_version?: string;
  };
  deviceHealth?: {
    cpu_pct?: number;
    mem_used_pct?: number;
    disk_used_pct?: number;
    last_heartbeat?: number;
  };
}

const AVAILABLE_METRICS = [
  "cpu_pct",
  "mem_used_pct",
  "disk_used_pct",
  "net_io_bytes_sent",
  "net_io_bytes_recv",
];

export default function FleetPage() {
  const [devices, setDevices] = useState<DeviceShadow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingDevice, setEditingDevice] = useState<string | null>(null);
  const [pendingMetrics, setPendingMetrics] = useState<string[]>([]);
  const deploymentId = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("deployment") ?? ""
    : "";

  const fetchDevices = async () => {
    try {
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();
      const res = await fetch(`/api/fleet?deployment=${deploymentId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setDevices(data.devices ?? []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDevices();
    const interval = setInterval(fetchDevices, 10_000);
    return () => clearInterval(interval);
  }, [deploymentId]);

  const heartbeatAge = (ts?: number) => {
    if (!ts) return null;
    return Math.round((Date.now() - ts) / 1000);
  };

  const onlineStatus = (device: DeviceShadow): "online" | "offline" | "unknown" => {
    const age = heartbeatAge(device.deviceHealth?.last_heartbeat);
    if (age === null) {
      return device.connectivity?.connected ? "online" : "unknown";
    }
    return age < 60 ? "online" : "offline";
  };

  const updateMetrics = async (thingName: string, metrics: string[]) => {
    try {
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();
      await fetch("/api/shadow", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          thingName,
          shadowName: "device-config",
          desired: { metrics },
        }),
      });
      setEditingDevice(null);
      fetchDevices();
    } catch (e: any) {
      alert("Failed to update shadow: " + e.message);
    }
  };

  if (loading) return <div className="page">Loading devices…</div>;
  if (error)
    return (
      <div className="page" style={{ color: "red" }}>
        Error: {error}
      </div>
    );

  return (
    <div className="page">
      <h1 className="page-title">Device Fleet {deploymentId && `— ${deploymentId}`}</h1>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Device</th>
              <th>Status</th>
              <th>Heartbeat</th>
              <th>CPU %</th>
              <th>Mem %</th>
              <th>Disk %</th>
              <th>Config ver.</th>
              <th>Metrics</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => {
              const status = onlineStatus(d);
              const age = heartbeatAge(d.deviceHealth?.last_heartbeat);
              return (
                <tr key={d.thingName}>
                  <td>{d.thingName}</td>
                  <td>
                    <span className={`badge badge-${status}`}>{status}</span>
                  </td>
                  <td>{age !== null ? `${age}s ago` : "—"}</td>
                  <td>{d.deviceHealth?.cpu_pct?.toFixed(1) ?? "—"}</td>
                  <td>{d.deviceHealth?.mem_used_pct?.toFixed(1) ?? "—"}</td>
                  <td>{d.deviceHealth?.disk_used_pct?.toFixed(1) ?? "—"}</td>
                  <td>{d.deviceConfig?.config_version ?? "—"}</td>
                  <td style={{ fontSize: "0.8rem" }}>
                    {d.deviceConfig?.metrics?.join(", ") ?? "—"}
                  </td>
                  <td>
                    {editingDevice === d.thingName ? (
                      <div>
                        {AVAILABLE_METRICS.map((m) => (
                          <label key={m} style={{ display: "block", fontSize: "0.8rem" }}>
                            <input
                              type="checkbox"
                              checked={pendingMetrics.includes(m)}
                              onChange={(e) =>
                                setPendingMetrics((prev) =>
                                  e.target.checked
                                    ? [...prev, m]
                                    : prev.filter((x) => x !== m)
                                )
                              }
                            />{" "}
                            {m}
                          </label>
                        ))}
                        <button
                          onClick={() => updateMetrics(d.thingName, pendingMetrics)}
                          style={{ marginTop: "0.4rem", marginRight: "0.4rem" }}
                        >
                          Save
                        </button>
                        <button onClick={() => setEditingDevice(null)}>Cancel</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setEditingDevice(d.thingName);
                          setPendingMetrics(d.deviceConfig?.metrics ?? []);
                        }}
                      >
                        Edit tags
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
