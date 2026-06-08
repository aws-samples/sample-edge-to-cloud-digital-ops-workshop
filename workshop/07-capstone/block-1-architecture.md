# Block 1 — Architecture Walkthrough

**Duration:** 60 min

---

## Facilitator-Led Walkthrough

Walk through the complete data flow using the architecture diagram from [docs/notes/real-time-pipeline-architecture.md](../reference/architecture.md). For each component, discuss:

- What it does in the workshop vs what it does in production
- What changes when moving to real edge hardware (RKE2 vs K3s, Redpanda Enterprise vs CE, real sensors vs Python simulator)
- HA model: what happens when a node fails at the edge vs in the cloud

---

## Component-by-Component

| Component | Workshop | Production change |
|---|---|---|
| Edge K8s | K3s (fast to bootstrap) | RKE2 (FIPS 140-2 validated) |
| Edge stream buffer | Redpanda Community | Redpanda Enterprise (Tiered Storage, RBAC, FIPS) |
| Sensors | Python simulator on EC2 | Real sensors via OPC-UA or MQTT |
| WAN link | Public internet | Amazon Leo or private MPLS |
| Cloud K8s | EKS `t3.medium` nodes | EKS `m5.2xlarge` + Karpenter autoscaling |
| IoT provisioning | By claim (automated CDK) | By trusted user (field engineer + Cognito) |
