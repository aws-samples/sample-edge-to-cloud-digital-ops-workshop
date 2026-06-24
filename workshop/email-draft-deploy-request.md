**Subject:** Edge Digital Operations Workshop — Pre-Session Deployment Steps

---

Hi [Name],

We're excited to run the **Edge Digital Operations Workshop** with your team. Before we kick off, we need to deploy the workshop infrastructure into your AWS account. This is a one-time setup that needs to be done a day or two before your start date.

---

### What Gets Deployed

Each participant gets an isolated "slot" containing:

- 3× EC2 t3.medium instances (simulated edge devices)
- IoT Core provisioning template
- MSK Kafka cluster (2 brokers)
- AppSync Events API
- S3 bucket + Athena workgroup
- Shared VPCs for edge and cloud networking

Cold deploy takes **45–60 minutes** (EKS cluster creation dominates), so plan to run this the night before.

---

### Prerequisites

On the machine running the deploy:

- AWS CLI v2 configured with **admin credentials** for the target account
- Node.js 22 (`nvm use 22`)
- pnpm (`npm install -g pnpm`)

---

### Deployment Steps

```bash
# 1. Clone the workshop repo
git clone https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop.git
cd sample-edge-to-cloud-digital-ops-workshop

# 2. Install dependencies
pnpm install

# 3. Deploy all participant slots (list each slot ID for your attendee count)
pnpm run sandbox:all ws-slot00 ws-slot01 ws-slot02 ws-slot03 ws-slot04 \
  ws-slot05 ws-slot06 ws-slot07 ws-slot08 ws-slot09
```

The deploy script will automatically generate **`DEPLOYMENT_SUMMARY.md`** in the repo root once it finishes. That file is the key deliverable — it contains a personalized workshop URL for each participant slot with their Deployment ID pre-loaded, so all CLI commands in the labs automatically show their slot-specific values (no copy-paste errors).

---

### After the Deploy Completes

Open `DEPLOYMENT_SUMMARY.md`. For each participant slot you'll find:

- A **Workshop URL** to share with that participant — it pre-populates their slot ID into every code block in the labs
- Quick commands for smoke testing, creating Cognito login credentials, and teardown

**Create a Cognito user for each participant:**

```bash
scripts/create-workshop-user.sh ws-slot00 participant@example.com
```

**Run a quick smoke test to verify the slot is healthy:**

```bash
WORKSHOP_TEST_SLOT=ws-slot00 node scripts/smoke-test.mjs
```

---

### The Workshop Labs

The labs are live here: https://aws-samples.github.io/sample-edge-to-cloud-digital-ops-workshop/02-control/block-2-iot-job/

Full repo: https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop

---

Let me know if you hit any issues during the deploy or if you'd like to do a quick call to walk through the steps together.

[Your name]
