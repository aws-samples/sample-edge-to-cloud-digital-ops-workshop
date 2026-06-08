# Block 2 — Site View Exploration

**Duration:** 60 min

---

## Steps

1. Navigate to the **Site View** page in the HMI
2. Mouse over process equipment nodes — observe live sensor readings in the hover panel:
   - Pump pressure (PSI)
   - Slurry flow rate (BPM)
   - Blender RPM
   - Wellhead treating pressure (PSI)
   - Proppant concentration (lb/gal)
3. Observe nodes updating in real time as simulated values change

---

## Discussion

Trace the full data path for what you're seeing:

```
Python simulator
  → MQTT publish
  → Redpanda Connect (ingest bridge)
  → Redpanda (edge buffer)
  → Edge RisingWave (MV: mv_sensor_latest)
  → Next.js SSE Route Handler (SUBSCRIBE cursor)
  → EventSource in browser
  → React Flow node re-render
```

- What is an HMI (Human-Machine Interface) in an industrial context?
- How does this compare to a traditional SCADA system?
- What happens to this view if the WAN link goes down?
