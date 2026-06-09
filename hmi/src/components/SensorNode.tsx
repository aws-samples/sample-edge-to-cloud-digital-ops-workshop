"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "reactflow";

export interface SensorNodeData {
  label: string;
  sensor: string | null; // null = no sensor (e.g. manifold)
  value: number | null;
  unit: string;
  /** upper limit used for colour-coding */
  limit: number | null;
}

function statusColor(value: number | null, limit: number | null): string {
  if (value === null || limit === null) return "#30363d"; // grey — no data / no limit
  if (value >= limit) return "#da3633"; // red — over limit
  if (value >= limit * 0.8) return "#e3b341"; // yellow — near limit (top 20%)
  return "#238636"; // green — nominal
}

const baseStyle: React.CSSProperties = {
  minWidth: 140,
  padding: "10px 14px",
  borderRadius: 6,
  border: "1px solid #30363d",
  background: "#161b22",
  color: "#e6edf3",
  fontFamily: "inherit",
  fontSize: 12,
  textAlign: "center",
  boxShadow: "0 2px 6px rgba(0,0,0,0.5)",
};

function SensorNode({ data }: NodeProps<SensorNodeData>) {
  const color = statusColor(data.value, data.limit);

  const indicatorStyle: React.CSSProperties = {
    display: "inline-block",
    width: 10,
    height: 10,
    borderRadius: "50%",
    background: color,
    marginRight: 6,
    flexShrink: 0,
  };

  const labelStyle: React.CSSProperties = {
    fontWeight: 600,
    fontSize: 13,
    marginBottom: 6,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  };

  const valueStyle: React.CSSProperties = {
    fontSize: 18,
    fontWeight: 700,
    color: color === "#30363d" ? "#8b949e" : color,
    lineHeight: 1,
  };

  const unitStyle: React.CSSProperties = {
    fontSize: 10,
    color: "#8b949e",
    marginTop: 2,
  };

  return (
    <div style={{ ...baseStyle, borderColor: color }}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />

      <div style={labelStyle}>
        <span style={indicatorStyle} />
        {data.label}
      </div>

      {data.sensor !== null && (
        <>
          <div style={valueStyle}>
            {data.value !== null ? data.value.toLocaleString() : "—"}
          </div>
          <div style={unitStyle}>{data.unit}</div>
        </>
      )}

      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

export default memo(SensorNode);
