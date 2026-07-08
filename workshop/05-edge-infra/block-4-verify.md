# Block 4 — Verify Edge Data Pipeline

**Duration:** 45 min

---

## Steps

**1. Confirm sensor simulator is publishing**

```bash
kubectl logs -n edge deployment/redpanda-connect-ingest --tail=50
```
<!-- e2e:assert {"notContains": "error"} -->

You should see MQTT messages being received and written to Redpanda topics.

**2. Inspect Redpanda topics via Redpanda Console**

```bash
kubectl port-forward -n edge svc/redpanda-console 8080:8080
```
<!-- e2e:skip --><!-- long-lived foreground port-forward; not scriptable as a single bash block -->

Open in a browser:

```
http://localhost:8080
```

Navigate to **Topics → sensors.raw.\*** and confirm messages are flowing.

**3. Confirm RisingWave DDL ran (Helm post-install hook)**

The Helm chart includes a `post-install` Job that automatically runs `risingwave/ddl.sql` — creating the Kafka source and materialized views. Check it completed:

```bash
kubectl get job -n edge -l app.kubernetes.io/component=risingwave-ddl
kubectl logs -n edge job/edge-stack-rw-ddl
```
<!-- e2e:assert {"contains": "CREATE MATERIALIZED VIEW"} -->

If the job failed, re-run manually:

```bash
kubectl port-forward -n edge svc/edge-stack-risingwave 4566:4566 &
psql -h localhost -p 4566 -U root -f risingwave/ddl.sql
```
<!-- e2e:skip --><!-- remediation path only run if the post-install hook failed; not exercised on a routine passing doc-runner run -->

**4. Confirm RisingWave materialized views are computing**

```bash
kubectl port-forward -n edge svc/edge-stack-risingwave 4566:4566 &
psql -h localhost -p 4566 -U root -c "SELECT * FROM mv_sensor_latest LIMIT 5;"
```
<!-- e2e:assert {"contains": "row"} -->

**5. Confirm WAN relay is forwarding to cloud MSK**

```bash
kubectl logs -n edge deployment/redpanda-connect-relay --tail=50
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
