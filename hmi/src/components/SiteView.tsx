"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
} from "reactflow";
import "reactflow/dist/style.css";
import SensorNode, { type SensorNodeData } from "./SensorNode";

// ── sensor metadata ────────────────────────────────────────────────────────────

const SENSOR_META: Record<
  string,
  { nodeId: string; unit: string; limit: number }
> = {
  pump_pressure_1: { nodeId: "pump-1", unit: "PSI", limit: 15000 },
  pump_pressure_2: { nodeId: "pump-2", unit: "PSI", limit: 15000 },
  pump_pressure_3: { nodeId: "pump-3", unit: "PSI", limit: 15000 },
  blender_rpm: { nodeId: "blender", unit: "RPM", limit: 1200 },
  wellhead_pressure: { nodeId: "wellhead", unit: "PSI", limit: 12000 },
  annular_pressure: { nodeId: "annulus", unit: "PSI", limit: 10000 },
};

// ── initial nodes ──────────────────────────────────────────────────────────────

function makeNodes(): Node<SensorNodeData>[] {
  return [
    {
      id: "pump-1",
      type: "sensorNode",
      position: { x: 60, y: 60 },
      data: {
        label: "Pump Truck 1",
        sensor: "pump_pressure_1",
        value: null,
        unit: "PSI",
        limit: 15000,
      },
    },
    {
      id: "pump-2",
      type: "sensorNode",
      position: { x: 60, y: 200 },
      data: {
        label: "Pump Truck 2",
        sensor: "pump_pressure_2",
        value: null,
        unit: "PSI",
        limit: 15000,
      },
    },
    {
      id: "pump-3",
      type: "sensorNode",
      position: { x: 60, y: 340 },
      data: {
        label: "Pump Truck 3",
        sensor: "pump_pressure_3",
        value: null,
        unit: "PSI",
        limit: 15000,
      },
    },
    {
      id: "blender",
      type: "sensorNode",
      position: { x: 60, y: 480 },
      data: {
        label: "Blender",
        sensor: "blender_rpm",
        value: null,
        unit: "RPM",
        limit: 1200,
      },
    },
    {
      id: "manifold",
      type: "sensorNode",
      position: { x: 360, y: 260 },
      data: {
        label: "High-Pressure Manifold",
        sensor: null,
        value: null,
        unit: "",
        limit: null,
      },
    },
    {
      id: "wellhead",
      type: "sensorNode",
      position: { x: 620, y: 200 },
      data: {
        label: "Wellhead",
        sensor: "wellhead_pressure",
        value: null,
        unit: "PSI",
        limit: 12000,
      },
    },
    {
      id: "annulus",
      type: "sensorNode",
      position: { x: 620, y: 360 },
      data: {
        label: "Annular",
        sensor: "annular_pressure",
        value: null,
        unit: "PSI",
        limit: 10000,
      },
    },
  ];
}

const INITIAL_EDGES: Edge[] = [
  { id: "e-p1-m", source: "pump-1", target: "manifold", animated: true },
  { id: "e-p2-m", source: "pump-2", target: "manifold", animated: true },
  { id: "e-p3-m", source: "pump-3", target: "manifold", animated: true },
  { id: "e-b-m", source: "blender", target: "manifold", animated: true },
  { id: "e-m-w", source: "manifold", target: "wellhead", animated: true },
  { id: "e-w-a", source: "wellhead", target: "annulus", animated: true },
];

const NODE_TYPES = { sensorNode: SensorNode };

// ── status badge ───────────────────────────────────────────────────────────────

function StatusBadge({ connected }: { connected: boolean }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        zIndex: 10,
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: "#161b22",
        border: "1px solid #30363d",
        borderRadius: 4,
        padding: "4px 10px",
        fontSize: 12,
        color: "#8b949e",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: connected ? "#238636" : "#da3633",
          display: "inline-block",
        }}
      />
      {connected ? "Live — RisingWave" : "Connecting…"}
    </div>
  );
}

// ── main component ─────────────────────────────────────────────────────────────

export default function SiteView() {
  const [nodes, setNodes, onNodesChange] = useNodesState(makeNodes());
  const [edges, setEdges, onEdgesChange] = useEdgesState(INITIAL_EDGES);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  );

  useEffect(() => {
    const es = new EventSource("/api/live-stream");
    esRef.current = es;

    es.addEventListener("open", () => setConnected(true));

    es.addEventListener("sensor", (e: MessageEvent) => {
      try {
        const row = JSON.parse(e.data) as {
          sensor: string;
          value: number;
          site_id: string;
        };
        const meta = SENSOR_META[row.sensor];
        if (!meta) return;

        setNodes((nds) =>
          nds.map((n) => {
            if (n.id !== meta.nodeId) return n;
            return {
              ...n,
              data: {
                ...n.data,
                value: row.value,
              },
            };
          })
        );
      } catch {
        // malformed payload — ignore
      }
    });

    es.addEventListener("error", () => {
      setConnected(false);
      // EventSource auto-reconnects; we'll flip connected back on next open
    });

    return () => {
      es.close();
    };
  }, [setNodes]);

  return (
    <div style={{ position: "relative", width: "100%", height: "calc(100vh - 100px)" }}>
      <StatusBadge connected={connected} />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={NODE_TYPES}
        fitView
        proOptions={{ hideAttribution: true }}
        style={{ background: "#0d1117" }}
      >
        <Background color="#21262d" gap={24} />
        <Controls
          style={{ background: "#161b22", border: "1px solid #30363d" }}
        />
        <MiniMap
          style={{ background: "#161b22", border: "1px solid #30363d" }}
          nodeColor="#238636"
          maskColor="rgba(0,0,0,0.6)"
        />
      </ReactFlow>
    </div>
  );
}
