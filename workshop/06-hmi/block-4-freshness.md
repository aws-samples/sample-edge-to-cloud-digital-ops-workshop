# Block 4 — Compare Edge vs Cloud Freshness

**Duration:** 45 min

---

## Side-by-Side Comparison

Port-forward simultaneously and open each dashboard in a browser tab:

```bash
# Edge HMI (already running from Block 1)
kubectl port-forward -n edge svc/edge-stack-hmi 3000:3000 > /tmp/hmi-pf2.log 2>&1 &
HMI_PF_PID=$!
# Wait for the forward to bind rather than racing a fixed sleep.
until grep -q "Forwarding from" /tmp/hmi-pf2.log 2>/dev/null; do sleep 1; done
curl -sf http://localhost:3000 | head -c 200
kill "$HMI_PF_PID" 2>/dev/null || true

# (Cloud Amplify front end loads from its hosted URL — no port-forward needed)
```
<!-- e2e:assert {"contains": "<"} -->

---

## Freshness Comparison Table

| Dashboard | Data source | Mechanism | Expected freshness |
|---|---|---|---|
| **Edge HMI — Frac Site** | Edge RisingWave MV | SSE via Next.js `SUBSCRIBE` cursor | ~100–300 ms (LAN) |
| **Cloud UI — RisingWave panel** | Cloud RisingWave MV (`fleet_disk`) | SSE via ALB → Next.js `SUBSCRIBE` cursor | ~300–650 ms (low-latency WAN) |
| **Cloud UI — TimescaleDB panel** | Cloud TimescaleDB CAGG | SSE via ALB + LISTEN/NOTIFY + 60 s window query | ~200–500 ms (WAN) |
| **Cloud UI — Iceberg reference tile** | Static label | Athena console only | tens of s up to ~300 s *(Firehose buffering interval — 128 MB or 300 s, whichever fires first)* |

---

## Discussion

- Why is the edge HMI faster than the cloud UI for the same sensor data?
- What changes if the WAN link is a geostationary satellite (latency ~600 ms) instead of fibre?
- At what point does the cloud RisingWave freshness become operationally acceptable for process control?

---

## Wrap-Up

Recap the full architecture: simulated sensors at the edge, through MQTT → Redpanda → cloud pipeline, to three cloud storage tiers, visible in two front ends.

**Production implications:**
- RKE2 instead of K3s for FIPS 140-2 compliance
- Redpanda Enterprise for Tiered Storage and RBAC
- Amazon Leo as a preferred low-latency WAN path for offshore/remote sites
