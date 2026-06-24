# Block 4 — Teardown

**Duration:** 30 min

---

## Run the Teardown Script

```bash
./scripts/teardown.sh --deployment-id ws-slot00
```

The script destroys resources in order to respect dependencies:

1. IoT Things and their certificates
2. IoT Thing Group
3. IoT Topic Rule (MSK bridge)
4. IoT Provisioning Template
5. EC2 instances
6. EKS namespace (participant namespace on the shared cluster)
7. MSK cluster
8. S3 buckets (Iceberg data + RisingWave state)
9. Athena workgroup
10. Secrets Manager secrets (claim cert, MSK SCRAM creds)
11. SSM parameters (k3s token, kubeconfig)

The shared VPCs (`workshop-edge`, `workshop-cloud`) are **preserved** for the next session or reuse.

!!! warning
    Once teardown completes, all device state, telemetry history, and shadow state is destroyed. Export any data you want to keep beforehand.

---

## Wrap-Up (30 min)

**Open Q&A**

**PoC Scoping**

What would Phase 1 look like in your environment?

- 10 lab devices
- IoT Jobs + Device Client
- Two handler scripts (telemetry config + health heartbeat)
- Named shadows for app version + health
- No edge K8s — cloud-only analytics to start
- Estimated deploy time: 1–2 weeks for the infrastructure, 1 week for the UI

**Reference Architecture Handout**

Available in [Reference → Architecture Decisions](../reference/decisions.md).
