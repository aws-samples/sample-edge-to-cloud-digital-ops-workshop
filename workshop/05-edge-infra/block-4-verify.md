# Block 4 — Verify Edge Data Pipeline

**Duration:** 45 min

---

## Steps

**1. Confirm sensor simulator is publishing**

```bash
kubectl logs -n edge deployment/redpanda-connect-ingest --tail=50
```

You should see MQTT messages being received and written to Redpanda topics.

**2. Inspect Redpanda topics via Redpanda Console**

```bash
kubectl port-forward -n edge svc/redpanda-console 8080:8080
```

Open `http://localhost:8080`. Navigate to **Topics → sensors.raw.\*** and confirm messages are flowing.

**3. Bootstrap RisingWave DDL (one-time)**

```bash
kubectl port-forward -n edge svc/edge-risingwave 4566:4566 &
psql -h localhost -p 4566 -U root -f risingwave/ddl.sql
```

This creates the `sensors_raw` Kafka source, `mv_sensor_latest`, and `mv_sensor_1min_avg` materialized views. Re-running is safe (`IF NOT EXISTS`).

**4. Confirm RisingWave materialized views are computing**

```bash
psql -h localhost -p 4566 -U root -c "SELECT * FROM mv_sensor_latest LIMIT 5;"
```

**5. Confirm WAN relay is forwarding to cloud MSK**

```bash
kubectl logs -n edge deployment/redpanda-connect-relay --tail=50
```

Check consumer group lag in the cloud MSK console — it should be near zero.

---

## Wrap-Up

The edge stack is now live. Data flows:

```
Sensor simulator → MQTT → Redpanda Connect → Redpanda
  ├─► Edge RisingWave → Next.js SSE → HMI browser
  └─► WAN relay → Cloud MSK → Cloud analytics
```

**Preview Session 6:** Use the Next.js HMI via port-forwarding to visualize the industrial site, explore Digital Ops metrics, and simulate a network failure.
