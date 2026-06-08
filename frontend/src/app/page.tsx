"use client";
import Link from "next/link";

export default function Home() {
  return (
    <div className="page">
      <h1 className="page-title">Edge Digital Ops Workshop</h1>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: "1rem" }}>
        <Link href="/fleet" style={{ textDecoration: "none" }}>
          <div className="card" style={{ cursor: "pointer" }}>
            <h2 style={{ marginBottom: "0.5rem" }}>Device Fleet</h2>
            <p style={{ color: "#666", fontSize: "0.9rem" }}>View all registered IoT devices, shadow state, heartbeat, and configure telemetry tags.</p>
          </div>
        </Link>
        <Link href="/freshness" style={{ textDecoration: "none" }}>
          <div className="card" style={{ cursor: "pointer" }}>
            <h2 style={{ marginBottom: "0.5rem" }}>Data Freshness</h2>
            <p style={{ color: "#666", fontSize: "0.9rem" }}>Compare live data freshness across RisingWave, TimescaleDB, and Hudi/Athena.</p>
          </div>
        </Link>
      </div>
    </div>
  );
}
