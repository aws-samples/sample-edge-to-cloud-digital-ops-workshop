# Repository Structure

```
edge-digital-ops-workshop/
├── amplify/                    # Amplify Gen 2 project root
│   ├── backend.ts              # Custom CDK constructs (MSK, EKS, IoT, Athena)
│   └── auth/                   # Cognito user pool per deployment
├── cdk/
│   ├── platform-stack/         # Shared VPCs, subnets, route tables
│   ├── participant-stack/      # Per-deployment resources (IoT, MSK, EKS, S3)
│   │   └── provisioning.ts     # Fleet provisioning template + claim cert logic
│   └── sensor-simulator/       # Session 5 sensor EC2 CDK construct
├── helm/
│   ├── edge-stack/             # Umbrella chart: Redpanda, RisingWave, CNPG, MinIO, HMI
│   ├── risingwave-values.yaml
│   └── rp-connect-timescaledb.yaml
├── k8s/
│   └── timescaledb-cluster.yaml
├── hmi/                        # Next.js HMI (React Flow site view + Digital Ops page)
├── frontend/                   # Amplify-hosted cloud UI (device fleet, freshness comparison)
├── scripts/
│   ├── create-workshop-user.sh # Create Cognito user for the front-end UI
│   └── teardown.sh             # Ordered resource cleanup
├── job-scripts/                # IoT Job handler scripts (deployed to devices via Jobs)
│   ├── telemetry-v2.sh         # Session 2: 1 Hz + network metrics
│   ├── deploy-k3s.sh           # Session 5: K3s cluster bootstrap
│   └── add-shadows.sh          # Session 3: app-deployment + device-health shadows
├── workshop/                   # MkDocs source (this documentation)
│   ├── index.md
│   ├── 00-prerequisites/
│   ├── 01-observe/
│   ├── 02-control/
│   ├── 03-state/
│   ├── 04-analytics/
│   ├── 05-edge-infra/
│   ├── 06-hmi/
│   ├── 07-capstone/
│   └── reference/
├── docs/
│   ├── workshop-plan.md        # Full session plan (source of truth)
│   ├── intent.md
│   └── notes/
│       ├── real-time-pipeline-architecture.md
│       └── ...
└── mkdocs.yml                  # MkDocs configuration
```
