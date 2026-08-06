# Repository Structure

```
edge-digital-ops-workshop/
├── amplify/
│   ├── backend.ts                  # Amplify Gen 2 entry point
│   ├── auth/                       # Cognito user pool per deployment
│   └── custom/
│       ├── participant-stack.ts    # Per-deployment resources (IoT, MSK, S3, AppSync)
│       └── platform-stack.ts      # Shared VPCs, subnets, route tables
├── frontend/                       # Amplify-hosted cloud UI (fleet view, freshness panel)
├── job-scripts/                    # IoT Job handler scripts (deployed to devices via Jobs)
│   ├── telemetry-v1.sh             # Session 2: shadow-driven telemetry config (starting point)
│   ├── telemetry-v2.sh             # Session 2: 3-decimal measurement precision (job exercise)
│   ├── deploy-k3s.sh               # Session 5: K3s cluster bootstrap
│   └── add-shadows.sh              # Session 3: app-deployment + device-health shadows
├── scripts/
│   ├── create-workshop-user.sh     # Create Cognito user for the front-end UI
│   ├── grant-ci-access.sh          # Grant a CI/facilitator role EKS + Cognito access
│   ├── edge-kubeconfig.sh          # SSM port-forward kubectl to a slot's private K3s
│   └── teardown.sh                 # Ordered resource cleanup
├── workshop/                       # MkDocs source (this documentation)
│   ├── index.md
│   ├── javascripts/
│   │   └── deployment-id.js        # Client-side ?did= deployment ID substitution
│   ├── snippets/                   # Reserved for future snippet fragments (currently empty)
│   ├── 00-prerequisites/
│   ├── 01-observe/
│   ├── 02-control/
│   ├── 03-state/
│   ├── 04-analytics/
│   ├── 05-edge-infra/
│   ├── 06-hmi/
│   ├── 07-capstone/
│   └── reference/
├── docs/                           # Internal facilitator notes (not published)
│   ├── workshop-plan.md
│   ├── intent.md
│   └── notes/
├── requirements.txt                # Python deps for MkDocs (mkdocs-material)
└── mkdocs.yml                      # MkDocs configuration
```
