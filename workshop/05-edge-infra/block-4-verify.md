# Block 4 — Verify Edge Data Pipeline

**Duration:** 45 min

---

## Steps

**1. Confirm sensor simulator is publishing**

```bash
kubectl logs -n edge deployment/edge-stack-rp-connect-ingest --tail=50
```
<!-- e2e:assert {"notContains": "error"} -->

You should see MQTT messages being received and written to Redpanda topics.

**2. Inspect Redpanda topics via Redpanda Console**

```bash
kubectl port-forward -n edge svc/edge-stack-console 8080:8080 > /tmp/redpanda-console-pf.log 2>&1 &
RC_PF_PID=$!
sleep 5
curl -sf http://localhost:8080 | head -c 200
kill "$RC_PF_PID" 2>/dev/null || true
```
<!-- e2e:assert {"contains": "<"} -->

Or open `http://localhost:8080` in a browser (keep the port-forward running in a separate terminal) and navigate to **Topics → sensors.raw.\*** to confirm messages are flowing.

**3. Confirm RisingWave DDL ran (Helm post-install hook)**

The Helm chart includes a `post-install` Job that automatically runs `risingwave/ddl.sql` — creating the Kafka source and materialized views. Check it completed:

```bash
kubectl get job -n edge -l app.kubernetes.io/component=risingwave-ddl
kubectl logs -n edge job/edge-stack-rw-ddl
```
<!-- e2e:assert {"contains": "CREATE MATERIALIZED VIEW"} -->

If the job failed, re-run manually — `risingwave/ddl.sql` uses `CREATE ... IF NOT EXISTS` throughout, so it's safe to re-run even when the post-install hook already succeeded:

```bash
kubectl port-forward -n edge svc/edge-stack-risingwave 4567:4567 > /tmp/rw-edge-pf.log 2>&1 &
RW_PF_PID=$!
sleep 5
psql -h localhost -p 4567 -U root -f risingwave/ddl.sql
kill "$RW_PF_PID" 2>/dev/null || true
```
<!-- e2e:assert {"contains": "CREATE MATERIALIZED VIEW"} -->

**4. Confirm RisingWave materialized views are computing**

```bash
kubectl port-forward -n edge svc/edge-stack-risingwave 4567:4567 > /tmp/rw-edge-pf2.log 2>&1 &
RW_PF_PID=$!
sleep 5
psql -h localhost -p 4567 -U root -c "SELECT * FROM mv_sensor_latest LIMIT 5;"
kill "$RW_PF_PID" 2>/dev/null || true
```
<!-- e2e:assert {"contains": "row"} -->

**5. Confirm WAN relay is forwarding to cloud MSK**

```bash
kubectl logs -n edge deployment/edge-stack-rp-connect-relay --tail=50
```
<!-- e2e:assert {"notContains": "error"} -->

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
