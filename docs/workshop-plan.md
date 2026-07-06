# Edge Digital Operations Workshop — Full Plan

**Format:** 4-hour sessions, once per week, 7 weeks
**Audience:** Engineers familiar with AWS console and basic Linux
**Prerequisite:** Cloud admin deploys platform stack before Session 1 (see Pre-Req below)

---

## Pre-Requisite: Admin Platform Deployment

> Performed by a cloud admin **before Session 1**. Participants never touch this step.

The entire workshop is built on top of an AWS Amplify Gen 2 project. The Amplify project is the deployment root — it deploys custom CDK constructs via `amplify/backend.ts` backend extensions, then adds application-layer resources (Cognito, AppSync Events API, S3 hosting) on top.

### What gets deployed (per participant slot, n=10 by default)

Each deployment gets a unique **`DEPLOYMENT_ID`** (e.g., `ws-a1b2c3`). All resource names and MQTT topic paths are namespaced with this ID to avoid cross-slot conflicts.

| Resource | Config | Notes |
|---|---|---|
| VPC `workshop-edge` | 1× per account, shared | 10.0.0.0/16; checked for existence before create |
| VPC `workshop-cloud` | 1× per account, shared | 10.1.0.0/16; checked for existence before create |
| Edge subnets (`/24`) | 1× per deployment, in `workshop-edge` VPC | Private-with-egress; routes to the shared NAT gateway, no cross-subnet routes — network-isolated |
| Cloud subnets | 1× per deployment, in `workshop-cloud` VPC | Standard routing |
| EC2 instances (t3.medium) | 3× per deployment | User data installs IoT Device Client; fleet provisioning by claim |
| IoT Provisioning Template | 1× per deployment | Claim cert embedded in user data; permanent cert issued on first boot |
| IoT Thing Group | 1× per deployment | Dynamic group: `deploymentId = {DEPLOYMENT_ID}` |
| MSK Provisioned cluster | 1× per deployment | `kafka.t3.small` × 2 brokers; SASL/SCRAM auth; VPC destination for IoT Rules |
| EKS cluster | 1× per deployment | In `workshop-cloud` VPC; `t3.medium` nodes; hosts cloud RisingWave + TimescaleDB |
| IoT Rule | 1× per deployment | Routes `edge/{DEPLOYMENT_ID}/+/telemetry` → MSK topic `raw.telemetry` |
| MSK Connect connector | 1× per deployment | Hudi Sink Connector reads `raw.telemetry` from MSK; writes Hudi MoR table → `s3://workshop-{DEPLOYMENT_ID}/telemetry/` |
| S3 bucket | 1× per deployment | Hudi MoR table written by MSK Connect Hudi Sink; table registered in Glue catalog on first write |
| Athena workgroup | 1× per deployment | Engine v3; participants `AssumeRole` into it |
| Amplify app + hosting | 1× per account, shared | Cognito user pool per deployment; AppSync Events API |
| AppSync Events API | 1× per account | HTTP publish endpoint: `POST https://{HTTP_DOMAIN}/event` — no Lambda required |

**VPC count math:** 2 shared VPCs total (edge + cloud), regardless of participant count. No per-participant VPC. Well within the default 5-VPC limit.

**Estimated cold deploy time:** 45–60 min (MSK + EKS dominate). Pre-deploy the night before.

**References:**
- Amplify Gen 2 custom CDK backends: https://docs.amplify.aws/react/build-a-backend/add-aws-services/custom-resources/
- AppSync Events HTTP publish: https://docs.aws.amazon.com/appsync/latest/eventapi/publish-http.html
- IoT Fleet Provisioning by claim: https://docs.aws.amazon.com/iot/latest/developerguide/provision-wo-cert.html
- IoT Rules Engine Kafka action (MSK Provisioned only — Serverless not supported): https://docs.aws.amazon.com/iot/latest/developerguide/apache-kafka-rule-action.html

---

## Initial Telemetry Configuration

Devices publish OS metrics as soon as they register. Initial config (pre-Step 2 update):

- **Frequency:** 0.2 Hz (one message every 5 seconds)
- **Metrics published:** CPU %, memory used %, disk used % — _network I/O intentionally omitted until Step 2_
- **Topic pattern:** `edge/{DEPLOYMENT_ID}/{THING_NAME}/telemetry`
- **Device shadow at boot:** `device-config` named shadow only

```json
{
  "state": {
    "reported": {
      "telemetry_interval_ms": 5000,
      "metrics": ["cpu_pct", "mem_used_pct", "disk_used_pct"],
      "config_version": "1.0.0"
    }
  }
}
```

**Clock sync:** All EC2 instances use Amazon Time Sync Service (`169.254.169.123`, Chrony). Athena queries use `current_timestamp` from Glue/Athena's own clock. Data freshness = `query_time - message_timestamp` where `message_timestamp` is the Unix epoch embedded in each MQTT payload.

---

## Session 1 — Observe: The Data in Motion

**Duration:** 4 hours
**Blocks:** 0 (45 min) + 1 (45 min) + 2 (30 min) + 3 (45 min) + 4 (30 min) + wrap-up (15 min) = 3h30m with ~30 min buffer
**Goal:** Participants understand how devices get registered into IoT Core, then observe the full data path from EC2 → IoT Core → MSK → S3 → Athena and measure its freshness.

### Block 0 (45 min) — Fleet Provisioning: How Devices Get Into IoT Core

> No live provisioning happens here. This is a conceptual walkthrough and console tour. The 3 devices are already registered — we're explaining how they got there.

#### The Four Provisioning Approaches

Facilitator presents the four IoT Core provisioning approaches side by side:

| Approach | Who owns the CA | When does the device get its permanent cert | Best for |
|---|---|---|---|
| **Single-thing / manual** | AWS IoT CA | Before the device ships — operator creates it in the console | Lab devices, one-offs |
| **Provisioning by trusted user** | AWS IoT CA | At commissioning time — an authenticated actor (Cognito user, service account) generates it on demand via API | Any scale; natural fit when a commissioning workflow and authenticated users already exist |
| **Provisioning by claim** | AWS IoT CA | On first cloud connection — device arrives with a shared "claim" cert and exchanges it for a unique permanent cert generated live by AWS | Automated deployments with no human commissioning step; commodity hardware with no factory PKI |
| **JITP / JITR** | **You own the CA** — cert is signed by your own PKI, not AWS | **Before the device ships** — unique cert burned in at the factory (e.g. via HSM); IoT Core auto-creates the Thing on first connection when it recognises your CA | Hardware with factory-provisioned identity (HSM, secure enclave); organisations with an existing PKI that pre-dates IoT Core |

**The sharpest distinction:** by-claim and JITP/JITR both look like "device self-registers on first connection," but they differ fundamentally on who created the permanent cert and when. With by-claim the device arrives as a blank slate and AWS mints its identity on first boot. With JITP/JITR the device already holds its permanent identity from the factory floor — AWS just learns about it when the device first connects.

**Key distinction to draw:** Single-thing/manual and trusted user require an authenticated actor at provisioning time. By-claim and JITP/JITR let the device self-register with no human in the loop. For a workshop with 30 EC2 instances spinning up in parallel, by-claim is the only practical option — but for a production deployment where a technician is already on-site commissioning a node and already has Cognito credentials, trusted user is often the better fit.

#### Claim Flow Walkthrough (what actually happened in this deployment)

Walk through the code sample from the CDK stack (`cdk/participant-stack/provisioning.ts`):

1. **CDK creates a provisioning template** — defines what IoT resources to create when a device presents a claim cert (Thing name derived from EC2 instance ID, policy attached, permanent cert activated)
2. **CDK creates a claim certificate** — a shared credential with a tightly scoped IoT policy: can only connect and call the `$aws/certificates/create/*` and `$aws/provisioning-templates/{templateName}/provision/*` topics; nothing else
3. **CDK stores the claim cert and private key in Secrets Manager** — as a single JSON secret (`{"certificate": "...", "privateKey": "..."}`), scoped to the deployment. The EC2 instances are given an IAM instance profile with `secretsmanager:GetSecretValue` permission restricted to that specific secret ARN. Nothing sensitive goes into user data.

   > **Why not user data?** EC2 user data is readable in plaintext by anyone with `ec2:DescribeInstanceAttribute` on the instance — effectively not secret. Secrets Manager provides fine-grained access control, CloudTrail audit logging, and the cert never touches the instance metadata service.

4. **On first boot:** the user data script calls `aws secretsmanager get-secret-value` using the instance profile credential (no hardcoded keys), writes the claim cert and key to a temp path on disk, and starts the Device Client. The Device Client connects using the claim cert, calls `CreateKeysAndCertificate` to get a permanent cert, then calls `RegisterThing` → IoT Core creates the Thing, attaches the permanent cert, assigns the full IoT policy
5. **Claim cert files are deleted from disk** immediately after `RegisterThing` succeeds — the user data script removes them. The permanent cert written by Device Client is now the only credential on disk.
6. **Pre-provisioning hook Lambda validates the request before IoT Core acts on it** — this is a key security control when using a shared claim cert. The hook receives the provisioning parameters before any Thing or cert is created, and returns `allowProvisioning: true/false`. In this deployment the hook does two things: calls `iot:DescribeThing` to reject duplicate registrations, and calls `ec2:DescribeInstances` to verify the requesting Thing name corresponds to a real EC2 instance in the account carrying the expected deployment tags — so the shared claim cert is only useful to instances the CDK stack actually created.

   **Teaching point:** the specific logic here is less important than the pattern. A shared claim cert is a wide key — any device that obtains it can attempt provisioning. The pre-hook is where you narrow that surface: verify the device is known to some authoritative source (EC2 tags, a device registry, a manufacturing database) before allowing registration. The hook can contain any logic your security posture requires.

   **Reference:** Pre-provisioning hooks: https://docs.aws.amazon.com/iot/latest/developerguide/pre-provisioning-hook.html

**Console tour — navigate to each of these in IoT Core:**
- IoT Core → **Connect** → **Fleet Provisioning** → show the provisioning template JSON
- IoT Core → **Security** → **Certificates** → show the claim cert (status: `ACTIVE`, policy: provisioning-only)
- IoT Core → **Manage** → **Things** → open one device → show its permanent cert and attached policy
- IoT Core → **Security** → **Policies** → compare the claim cert policy (3 statements, provisioning topics only) vs the device operational policy (publish/subscribe on `edge/{DEPLOYMENT_ID}/#` and shadow topics)

#### Trusted User — The Production-Ready Alternative for This Architecture

**Provisioning by trusted user** is a fully scalable pattern — and it maps directly onto the Cognito user pool already deployed in this workshop.

The flow: a Cognito-authenticated user (field engineer, commissioning app, or automated service account) calls an AppSync mutation → a Lambda resolver with IAM permission calls `CreateProvisioningClaim` against the IoT Core management API → a **one-time-use** claim cert is returned. That cert is handed to the device (QR code scan, NFC tap, USB drop, or API push) and the device runs the same `RegisterThing` flow it would under by-claim. There is no shared static credential sitting in firmware or user data — each device gets a fresh, single-use cert generated on demand by a known, authenticated actor.

**Why it scales:** the trust anchor is the Cognito identity, not a secret embedded in an AMI. You can provision credentials to 10,000 field technicians through the same Cognito user pool that runs the management UI, revoke any individual's access instantly, and get a full CloudTrail audit log of who provisioned which device and when — at any fleet size.

**The actual trade-off between the two approaches:**

| | By claim | By trusted user |
|---|---|---|
| Human or service required at install | No | Yes — authenticated via Cognito or IAM |
| Per-provisioning audit trail | No (shared cert; no per-event identity) | Yes — Cognito identity + CloudTrail per device |
| Risk surface | Shared static cert must be kept secret | No shared secret; risk isolated to individual Cognito accounts |
| Works with no cloud connectivity at factory | Yes (cert baked into image) | No — needs a live API call to generate the claim |
| Fits this workshop's Cognito user pool | No | **Yes — directly** |

For a production deployment where a field engineer physically commissions a node on-site and already authenticates to the management UI via Cognito — trusted user is the natural long-term production pattern. By-claim is used in this workshop purely because the CDK deployment is fully automated with no human commissioning step.

**References:**
- Provisioning by claim: https://docs.aws.amazon.com/iot/latest/developerguide/provision-wo-cert.html
- Provisioning by trusted user: https://docs.aws.amazon.com/iot/latest/developerguide/provision-wo-cert.html#trusted-user
- Fleet provisioning template reference: https://docs.aws.amazon.com/iot/latest/developerguide/provision-template.html
- Provisioning by claim — certificate security best practices: https://docs.aws.amazon.com/iot/latest/developerguide/provision-wo-cert.html#claim-based-provisioning

---

### Block 1 (45 min) — Orientation & Console Tour

- Facilitator walks through the deployed architecture diagram
- Participants navigate to IoT Core console → **Test** → **MQTT test client**
- Subscribe to `edge/{YOUR_DEPLOYMENT_ID}/#`
- Observe incoming telemetry messages (0.2 Hz); inspect JSON payload structure
- Navigate to IoT Core → **Manage** → **Things** → confirm 3 registered devices — these are the same devices whose provisioning flow was just explained
- Check `device-config` named shadow on each device

**Key discussion:** Why MQTT? What is a topic namespace? Now that participants understand provisioning, connect the dots: the Thing name in the topic path matches the Thing created by the provisioning template.

**Reference:** IoT Core MQTT test client: https://docs.aws.amazon.com/iot/latest/developerguide/view-mqtt-messages.html

### Block 2 (45 min) — S3 Observation

- Navigate to S3 → `workshop-{DEPLOYMENT_ID}/telemetry/`
- Observe Parquet files being created by MSK Connect (S3 Sink connector)
- Note the partition structure: `year=/month=/day=/hour=/`
- Open a file with S3 Select (Parquet) to inspect raw records

**Key discussion:** Why Parquet? What is Apache Hudi? What is MoR (Merge on Read)? Why does the MSK Connect Hudi Sink write batches rather than one file per message?

**MSK Connect with Hudi Sink Connector reference:** https://docs.aws.amazon.com/msk/latest/developerguide/msk-connect.html

### Block 3 (60 min) — Athena Data Freshness Query

- Navigate to Athena → workgroup `workshop-{DEPLOYMENT_ID}`
- The Hudi table is auto-registered in Glue catalog by the MSK Connect Hudi Sink on first write — no crawler run needed
- Run the provided data freshness query:

```sql
SELECT
  thing_name,
  MAX(message_timestamp) AS latest_edge_ts,
  current_timestamp AS query_ts,
  date_diff('second', MAX(message_timestamp), current_timestamp) AS freshness_seconds
FROM "workshop_{deployment_id}"."telemetry"
GROUP BY thing_name
ORDER BY freshness_seconds DESC;
```

- Observe that freshness is 30–90 seconds old (MSK Connect flush interval + Hudi delta log commit)
- Discuss: this is the **archive tier** — appropriate for compliance and ML, not operational dashboards

**Key discussion — why can't we just wire this to the dashboard?**

Walk through the chain of problems with serving a live operational dashboard directly from a Hudi/S3 table:

1. **No browser-native client.** There is no JavaScript library or React component that can read a Hudi table. The entire Hudi ecosystem is JVM (Spark, Flink, Trino) and Rust/Python server-side. Any browser access requires a query engine in the middle.
2. **Athena startup overhead is irreducible.** Even a simple incremental Hudi query through Athena incurs ~2–5 seconds of query planning and DPU startup before the first byte returns. At a 5-second dashboard refresh cadence, you'd be running a new query before the previous one finishes — and billing per query.
3. **MoR read amplification before compaction.** Until the Hudi compaction job runs, every Athena read must merge base Parquet files with Avro delta logs at query time. Freshness improves but read cost increases.
4. **The freshness floor is the batch write interval.** No matter how fast the query engine is, data can only be as fresh as the last Hudi commit. With MSK Connect writing micro-batches, that floor is ~30–90 seconds — far above what an operational dashboard needs.

**Conclusion:** The Hudi table is queried here in the AWS console to measure and understand its freshness floor. It has no route to the front-end dashboard. This is intentional — the gap between the Hudi freshness number and the RisingWave freshness number is the central argument for why the architecture has multiple tiers. Foreshadow Session 4 where the three tiers are shown side by side.

**Athena Hudi reference:** https://docs.aws.amazon.com/athena/latest/ug/querying-hudi.html

### Block 4 (45 min) — Fleet Indexing Introduction

- Navigate to IoT Core → **Fleet Hub** → use IoT Device Management console (Fleet Hub EOL Oct 2025)
- Run a Fleet Indexing query to find all 3 devices in this deployment:
  ```
  thingGroupNames:ws-{DEPLOYMENT_ID}
  ```
- Observe device connectivity status and last-seen timestamp
- Run a cross-fleet query: `connectivity.connected:true` → see all online devices across all deployments
- Discuss Dynamic Thing Groups: a group whose membership is re-evaluated automatically as device attributes change

**Reference:** Fleet Indexing query syntax: https://docs.aws.amazon.com/iot/latest/developerguide/query-syntax.html

### Wrap-up (15 min)
- Recap data path: EC2 → IoT Device Client → IoT Core → IoT Rules Engine → MSK → MSK Connect → S3 → Athena
- Tease Session 2: we'll use IoT Jobs to update the devices and change what data is flowing

---

## Session 2 — Control: Fleet Management with IoT Jobs

**Duration:** 4 hours
**Goal:** Participants use IoT Jobs to push a script update to all 3 devices simultaneously, change telemetry behavior, and experience fleet-level operations.

### Block 1 (45 min) — IoT Device Client Architecture

- Review how AWS IoT Device Client works as a systemd service alongside the EC2 application
- Inspect the job handler directory on one device via Systems Manager Session Manager (no SSH required)
- Walk through the existing `telemetry-config.sh` handler script structure
- Discuss: exit code 0 = SUCCESS reported to IoT Jobs; non-zero = FAILED

**Reference:** AWS IoT Device Client GitHub: https://github.com/awslabs/aws-iot-device-client

### Block 2 (60 min) — Create and Deploy an IoT Job

Participants create an IoT Job that deploys an updated telemetry script to all 3 devices:

**The update does two things:**
1. Changes publish frequency from 0.2 Hz → 1 Hz
2. Adds `net_io_bytes_sent` and `net_io_bytes_recv` metrics to the payload

**Workshop steps:**
1. Open `job-scripts/telemetry-v2.sh` in the workshop IDE (pre-cloned repo on the participant machine)
2. Read through the script — facilitator walks through the key sections:
   - The `TELEMETRY_INTERVAL_MS` variable being changed from `5000` → `1000`
   - The `METRICS` array being extended with `net_io_bytes_sent` and `net_io_bytes_recv`
   - The `aws iot update-thing-shadow` call at the end that reports `config_version: 2.0.0`
   - The `exit 0` / `exit 1` contract with IoT Device Client
3. Make the edits directly in the IDE: change the interval and add the two network metrics to the array
4. Upload the edited script to S3:
   ```bash
   aws s3 cp job-scripts/telemetry-v2.sh \
     s3://workshop-{DEPLOYMENT_ID}/job-scripts/telemetry-v2.sh
   ```
5. Create IoT Job in console: target = Thing Group `ws-{DEPLOYMENT_ID}`, document = pre-written job document
6. Configure rollout: max 1 device/minute, abort if >33% of devices fail
7. Observe job status per device: `IN_PROGRESS` → `SUCCEEDED`
8. Return to MQTT test client and observe: messages now arrive at 1 Hz, payload includes network metrics

**Job document (pre-written, participants just launch it):**
```json
{
  "operation": "update-telemetry-config",
  "scriptUrl": "s3://workshop-{DEPLOYMENT_ID}/job-scripts/telemetry-v2.sh",
  "version": "2.0.0"
}
```

**Reference:** IoT Jobs rollout configuration: https://docs.aws.amazon.com/iot/latest/developerguide/jobs-configurations-details.html

### Block 3 (45 min) — Fleet Management Deep Dive

- Navigate to IoT Core → **Software Package Catalog**
- Register `telemetry-agent` package, versions `1.0.0` and `2.0.0`
- Tag the 3 devices with `package_version=2.0.0` via job handler (the handler script does this automatically via `UpdateThingShadow`)
- Run Fleet Indexing query to confirm all devices report `2.0.0`:
  ```
  shadow.name.device-config.reported.config_version:2.0.0
  ```
- Simulate drift: manually edit one device's shadow desired state back to `1.0.0`
- Run drift detection query:
  ```
  NOT (shadow.name.device-config.desired.config_version:shadow.name.device-config.reported.config_version)
  ```
- Discuss: this is how you find devices that haven't converged

**Reference:** Software Package Catalog: https://docs.aws.amazon.com/iot/latest/developerguide/software-package-catalog.html

### Block 4 (45 min) — Observe the Updated Data Flow

- Return to S3 and Athena — new metrics now appearing in the Parquet files
- Run updated freshness query — now 5× more data points per minute
- Confirm new metrics `net_io_bytes_sent` / `net_io_bytes_recv` appear in query results
- Discuss: the fleet update happened without SSH, without manual intervention, with per-device status tracking

### Wrap-up (15 min)
- Recap IoT Jobs model: job document → rollout config → per-device status lifecycle
- Tease Session 3: device shadows + building the management UI

---

## Session 3 — State: Device Shadows and the Management UI

**Duration:** 4 hours
**Goal:** Add the remaining named shadows, use the front-end UI to observe device state, and experience failure detection via shadow staleness.

### Block 1 (45 min) — Named Shadow Architecture

Review the three-shadow design:

| Shadow Name | Owned By | Contains |
|---|---|---|
| `device-config` | Cloud (desired) + Device (reported) | Config version, telemetry interval, feature flags — **already deployed** |
| `app-deployment` | Cloud (desired) + Device (reported) | Compose version, container image tags, deploy status — **added this session** |
| `device-health` | Device (reported only) | CPU/mem/disk %, container count, uptime, last heartbeat — **added this session** |

**Reference:** Named Device Shadows: https://docs.aws.amazon.com/iot/latest/developerguide/iot-device-shadows.html

### Block 2 (60 min) — Deploy Shadow Update Job

Participants create an IoT Job that:
1. Adds `app-deployment` shadow reporting (reads current Docker Compose version from file, publishes to shadow)
2. Adds `device-health` shadow reporting (periodic heartbeat with system metrics, every 30 seconds)

**Steps:**
1. Create job targeting Thing Group `ws-{DEPLOYMENT_ID}`
2. Job script adds two new systemd timer units that publish to the new shadow topics
3. Observe new shadows appearing in IoT Core console
4. Use Fleet Indexing to query device health across the fleet:
   ```
   shadow.name.device-health.reported.cpu_pct:[50 TO *]
   ```

### Block 3 (60 min) — Front-End UI Walkthrough

The Amplify-hosted front end is now usable. First-time setup:

1. Facilitator (or participant) runs the provided script to create a Cognito user:
   ```bash
   ./scripts/create-workshop-user.sh --deployment-id ws-{DEPLOYMENT_ID}
   ```
2. Load the Amplify-hosted URL, sign in
3. **Device Fleet page:** Shows all 3 devices with live shadow state (last heartbeat, CPU, mem, disk, config version)
   - On-demand data (page load, manual refresh): AppSync GraphQL query → Lambda resolver → IoT Device Shadow REST API. Lambda is invoked once, fetches shadow state, returns, and stops. No Lambda runs while the page stays open.
   - Live push updates (shadow changes while the page is open): delivered via AppSync Events WebSocket subscription — Lambda is not involved in maintaining this connection at all.
4. **Tag Selector:** Each device shows its configured metrics tags. Use the UI to add `net_io_bytes_sent` to a device's `device-config` desired shadow `metrics` array
5. Observe the device pick up the delta and add the new metric to its telemetry stream (shadow delta → Device Client → handler script)

**AppSync Events — how the live update path works:**

AppSync Events fully manages all WebSocket connections and scaling without Lambda. The data flow is:

1. IoT Rule detects shadow update → triggers Lambda
2. Lambda POSTs the event to `https://{HTTP_DOMAIN}/event` (one HTTP call, Lambda then exits)
3. AppSync receives the HTTP POST and immediately broadcasts to all subscribed WebSocket clients
4. Browser receives the update over its open WebSocket connection — no Lambda involved in this broadcast

Lambda is invoked exactly once per shadow change event, not once per subscriber and not once per second of open connection. A user keeping the browser open all day costs zero ongoing Lambda invocations.

- Publish path (backend): `POST https://{HTTP_DOMAIN}/event` (plain HTTP — no WebSocket needed)
- Subscribe path (browser): `wss://{REALTIME_DOMAIN}/event/realtime` (WebSocket — managed entirely by AppSync)

**Reference:** AppSync Events HTTP publish: https://docs.aws.amazon.com/appsync/latest/eventapi/publish-http.html
**Reference:** AppSync Events concepts (WebSocket + HTTP support): https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-concepts.html
**Reference:** AppSync Events announcement: https://aws.amazon.com/blogs/mobile/announcing-aws-appsync-events-serverless-websocket-apis/

### Block 4 (45 min) — Failure Detection

**Simulate a failure:**
1. Participant stops one EC2 instance via EC2 console
2. Observe in UI: device heartbeat goes stale (device-health shadow `last_heartbeat` stops updating)
3. After ~90 seconds, the UI marks the device as `OFFLINE` (heartbeat age > 60 s threshold)
4. IoT Core connectivity status also shows `DISCONNECTED`
5. Discuss: two independent signals — shadow staleness (application-layer) + IoT Core connectivity (transport-layer)
6. Restart the instance; observe it reconnects using its existing permanent certificate (no re-provisioning — the claim cert was deleted after first boot; the Device Client simply re-establishes the MQTT connection and shadows re-populate)

### Wrap-up (15 min)
- Recap shadow model: desired/reported/delta pattern; named shadows for separation of concerns
- Tease Session 4: cloud analytics — RisingWave, TimescaleDB, and comparing data freshness across tiers

---

## Session 4 — Analytics: Cloud Telemetry Plane

**Duration:** 4 hours
**Goal:** Deploy RisingWave and TimescaleDB into the cloud EKS cluster, wire them to MSK, and compare live data freshness across three storage tiers.

### Block 1 (45 min) — Deploy Cloud Analytics Stack

Participants run Helm deployments against the pre-configured EKS cluster:

```bash
# Deploy RisingWave (consumes from MSK)
helm upgrade --install risingwave oci://ghcr.io/risingwavelabs/risingwave-operator \
  -n risingwave --create-namespace \
  -f helm/risingwave-values.yaml

# Deploy TimescaleDB via CloudNativePG
helm upgrade --install cnpg cloudnative-pg/cloudnative-pg -n cnpg-system --create-namespace
kubectl apply -f k8s/timescaledb-cluster.yaml

# Deploy Redpanda Connect (MSK → TimescaleDB bulk insert pipeline)
helm upgrade --install rp-connect redpanda/connectors \
  -f helm/rp-connect-timescaledb.yaml
```

All Helm values files are pre-staged in the repository. The MSK broker endpoints and credentials are injected from AWS Secrets Manager via the EKS pod identity.

**Reference:** RisingWave Kubernetes Operator: https://docs.risingwave.com/deploy/risingwave-kubernetes
**Reference:** CloudNativePG: https://cloudnative-pg.io/documentation/

### Block 2 (45 min) — Create RisingWave Materialized Views

Connect to RisingWave via `psql` (PostgreSQL wire protocol):

```sql
-- Connect RisingWave to MSK Kafka source
CREATE SOURCE telemetry_raw (
  thing_name VARCHAR,
  cpu_pct FLOAT,
  mem_used_pct FLOAT,
  disk_used_pct FLOAT,
  message_timestamp TIMESTAMPTZ
) WITH (
  connector = 'kafka',
  topic = 'raw.telemetry',
  properties.bootstrap.server = '{MSK_BOOTSTRAP}',
  scan.startup.mode = 'earliest'
) FORMAT PLAIN ENCODE JSON;

-- Materialized view: 5-minute rolling CPU window
CREATE MATERIALIZED VIEW cpu_5min AS
SELECT
  thing_name,
  window_start,
  AVG(cpu_pct) AS avg_cpu,
  MAX(cpu_pct) AS max_cpu
FROM TUMBLE(telemetry_raw, message_timestamp, INTERVAL '5 MINUTES')
GROUP BY thing_name, window_start;

-- Materialized view: per-device latest disk usage + fleet aggregate
-- Tracks disk_used_pct rising in real time — during the Session 6 network
-- failure simulation, Redpanda's local buffer fills as the WAN relay backs up,
-- which drives disk_used_pct up on the edge nodes. This view makes that visible.
CREATE MATERIALIZED VIEW fleet_disk AS
SELECT
  thing_name,
  disk_used_pct,
  CASE WHEN disk_used_pct >= 80 THEN 'CRITICAL'
       WHEN disk_used_pct >= 60 THEN 'WARNING'
       ELSE 'OK'
  END AS disk_status,
  message_timestamp AS last_seen
FROM (
  SELECT DISTINCT ON (thing_name) thing_name, disk_used_pct, message_timestamp
  FROM telemetry_raw
  ORDER BY thing_name, message_timestamp DESC
);

-- Fleet-level summary over the per-device latest values
CREATE MATERIALIZED VIEW fleet_disk_summary AS
SELECT
  MAX(disk_used_pct)                                    AS max_disk_pct,
  AVG(disk_used_pct)                                    AS avg_disk_pct,
  COUNT(*) FILTER (WHERE disk_used_pct >= 80)           AS critical_count,
  COUNT(*) FILTER (WHERE disk_used_pct >= 60
                     AND disk_used_pct < 80)            AS warning_count,
  COUNT(*)                                              AS device_count
FROM fleet_disk;
```

Query the views — observe sub-100 ms response times.

**Reference:** RisingWave streaming SQL: https://docs.risingwave.com/sql/overview

### Block 3 (60 min) — AppSync Resolvers and Data Freshness Comparison

The cloud front end uses four data delivery patterns across the tiers:

- **Live push — no persistence (IoT → AppSync Events):** IoT Rules Engine HTTP action → AppSync Events API publish → browser WebSocket subscriber — the message goes from device MQTT publish directly to the browser without touching any database; zero aggregation, maximum freshness
- **Live (RisingWave):** SSE stream over ALB → EKS Next.js server → RisingWave `SUBSCRIBE` — same pattern as the edge HMI, no polling, freshest possible data for pre-computed aggregations
- **Aggregation query (TimescaleDB):** AppSync Event arrives at browser → browser fires HTTP request → Next.js Route Handler queries TimescaleDB CAGG → response rendered — each incoming event drives a fresh query; the browser holds no persistent database connection
- **Console only (Hudi/Athena):** No front-end route — queried directly in the Athena console to measure and discuss the data lake freshness floor

#### Why ALB for SSE, not API Gateway

API Gateway (HTTP API or REST API) has a **maximum integration timeout of 300 seconds (5 minutes)** even after a quota increase — it is fundamentally incompatible with long-lived SSE connections. An internet-facing **ALB** is the right choice: idle timeout is configurable up to **4,000 seconds (~66 minutes)**, and the connection stays open indefinitely as long as the server sends periodic SSE heartbeat comments (`: ping`) within that window.

The live SSE stream runs through its own ALB listener, separate from the AppSync GraphQL API. Cognito JWT authorization is enforced at the ALB level using an ALB listener rule with `authenticate-cognito` action before traffic reaches the Next.js service in EKS.

**References:**
- API Gateway max timeout (300 s): https://aws.amazon.com/about-aws/whats-new/2024/06/amazon-api-gateway-integration-timeout-limit-29-seconds/
- ALB idle timeout (max 4,000 s): https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html
- ALB HTTP keepalive duration: https://aws.amazon.com/about-aws/whats-new/2024/03/application-load-balancer-http-keepalive-duration/

The RisingWave aggregation panels use the ALB SSE path. TimescaleDB serves aggregation queries on demand — the browser uses each incoming AppSync Event as the signal to fire an HTTP request. The IoT → AppSync live push path bypasses the ALB and both databases entirely.

#### RisingWave → SSE Architecture (cloud) — aggregation panels

```
Browser
  │  GET /api/risingwave-stream  (SSE, long-lived)
  ▼
ALB (internet-facing)
  │  authenticate-cognito listener rule
  │  idle timeout = 4,000 s; server sends ": ping" every 30 s
  ▼
EKS — Next.js App Router Route Handler
  │  node-postgres pg connection
  │  CREATE SUBSCRIPTION s1 ON fleet_disk ...
  │  DECLARE CURSOR c1 FOR SUBSCRIPTION s1
  │  loop: FETCH 100 FROM c1 → flush as SSE event
  ▼
Cloud RisingWave (in EKS, private VPC)
  consuming from MSK → fleet_disk / fleet_disk_summary materialized views
```

The Next.js server holds one `pg` connection to RisingWave per active SSE client. RisingWave's `SUBSCRIBE` cursor model streams incremental MV changes — rows arrive as new sensor data flows in from MSK, the Next.js loop fetches them and immediately flushes to the SSE response stream. Effective latency from MSK → browser: ~100–400 ms (RisingWave barrier latency + SSE flush).

#### TimescaleDB Query Architecture (cloud)

The browser receives an AppSync Event and uses it as the signal to fire an HTTP request to the Next.js Route Handler, which queries TimescaleDB and returns the result. The comparison panel uses the pump rate continuous sum — `SUM(pump_rate_bbl_per_min)` across all active pumps, re-evaluated on every incoming event.

```sql
-- CAGG definition (created once at deploy time)
CREATE MATERIALIZED VIEW pump_rate_10s
WITH (timescaledb.continuous) AS
SELECT time_bucket('10 seconds', message_timestamp) AS bucket,
       SUM(pump_rate_bbl_per_min) AS total_pump_rate
FROM telemetry_raw
GROUP BY bucket;

-- Query fired per AppSync Event
-- materialized_only=false forces a live scan of un-materialized rows
-- in the current bucket, making the freshness cost visible
SELECT total_pump_rate
FROM pump_rate_10s
WHERE bucket = (
  SELECT max(bucket) FROM pump_rate_10s
)
WITH (timescaledb.materialized_only=false);
```

```
AppSync Event arrives at browser
  │  browser fires POST /api/timescale-query
  ▼
ALB (internet-facing)
  │  authenticate-cognito listener rule
  ▼
EKS — Next.js App Router Route Handler
  │  node-postgres pg connection (pooled)
  │  runs pump-rate CAGG query
  ▼
Cloud TimescaleDB (in EKS, private VPC)
  hypertable: telemetry_raw
  CAGG: pump_rate_10s
```

> **Hudi/Athena has no front-end connection.** There is no JavaScript library or React component that can read a Hudi table natively. Any browser path requires a query engine (Athena, Trino, Spark) in the middle, which adds 2–15 seconds of irreducible overhead per query. The Hudi table is interacted with exclusively via the Athena console. Its freshness number is carried forward as a static reference tile.

#### Front-End Data Freshness Comparison Panel

The UI shows **three** panels. Each panel shows a relevant metric with a live `freshness_seconds` counter.

| Panel | Query pattern | Data path | Mechanism | Expected freshness |
|---|---|---|---|---|
| **Live push — raw telemetry** | Per-device raw event, no aggregation | IoT Core → IoT Rules HTTP action → AppSync Events API → browser WebSocket subscriber | AppSync Events push; no poll, no SSE, no database write | ~10–80 ms — IoT Rules HTTP dispatch + AppSync pub/sub; **bypasses both databases entirely** |
| **Fleet pump rate — RisingWave MV** | `SUM(pump_rate_bbl_per_min)` across all active pumps, incrementally maintained | AppSync Event → browser fires HTTP request → RisingWave MV lookup → rendered result | Single MV row read per event | See scale table below |
| **Fleet pump rate — TimescaleDB CAGG** | Same sum, computed via CAGG with live scan of un-materialized tail | AppSync Event → browser fires HTTP request → TimescaleDB CAGG query → rendered result | CAGG + live scan per event | See scale table below |

The pump rate panels show the same business question answered by two different engines side-by-side so the freshness difference is directly observable.

**The live push path skips the databases entirely.** The message travels device MQTT → IoT Core → IoT Rules HTTP action → AppSync Events → browser WebSocket. This path is exclusively for raw per-device events; it carries no aggregation capability.

**The pump rate aggregation is where the two engines differ structurally.** Each wellsite may have 2–6 pumps reporting `pump_rate_bbl_per_min` at 1 Hz. The operations team needs the current total injection rate across all active pumps in near-real-time — a safety and process control number, not a dashboard vanity metric. This is a *continuous aggregation* that never settles: it changes with every insert from any pump.

- **RisingWave**: `CREATE MATERIALIZED VIEW current_pump_rate AS SELECT SUM(pump_rate_bbl_per_min) AS total_rate FROM telemetry_raw WHERE message_timestamp > NOW() - INTERVAL '5 seconds'`. RisingWave incrementally maintains this using its streaming operator graph — on each new row, the SUM is updated in-memory, not recomputed from scratch. Read cost: a single MV row lookup.
- **TimescaleDB CAGG**: Must define a time bucket (e.g., 10-second buckets). With `materialized_only=false`, the query UNIONs the last materialized bucket with a live scan over all raw rows since the last watermark. Every AppSync-Event-triggered refresh re-scans those un-materialized rows.

**Production-scale estimate — heavy fleet day (all edge nodes reporting full telemetry):**

- **Assumed load:** 500 active edge nodes × 10 sensor tags × 1 Hz = **5,000 rows/second**
- **Un-materialized window** for pump rate CAGG (10-second bucket, 5 s `end_offset`): 5 s × 5,000 rows/s = **25,000 raw rows** live-scanned per query refresh
- **RisingWave MV query:** still a single row read — **no change in cost**

| | 3 devices (workshop) | 500 devices (production heavy day) |
|---|---|---|
| **Live push (IoT Rules → AppSync)** | ~10–80 ms | ~10–80 ms *(flat — per-message cost, independent of fleet size)* |
| **Pump rate — RisingWave MV** | ~100–400 ms | ~100–400 ms *(flat — incremental update; read is always one row)* |
| **Pump rate — TimescaleDB CAGG** | ~100–600 ms | **~500 ms–3 s** *(live scan over ~25K un-materialized rows; cost grows linearly with write rate)* |
| **Hudi/Athena** | ~30–90 s | ~30–120 s *(DPU startup cost is flat; scan size grows with data volume)* |

The pump rate is a concrete, high-stakes use case: if the total injection rate reads stale or wrong, an over-pressured well may go undetected. At workshop scale (3 devices) the CAGG and the RisingWave MV track each other closely. The scale table shows why they diverge at 500 devices — the un-materialized tail the CAGG must scan grows to ~25,000 rows per query, pushing freshness to 500 ms–3 s, while the RisingWave MV cost stays flat because it was updated incrementally on every insert.

**Teaching note:** Run both pump rate panels side-by-side at 3-device scale and observe they track each other. Then show the scale table and walk through what happens at 500 devices — the CAGG result becomes too stale to act on as a process control indicator.

### Block 4 (45 min) — TimescaleDB Continuous Aggregates

```sql
-- Continuous aggregate: hourly CPU summary (pre-computes on new data)
CREATE MATERIALIZED VIEW cpu_hourly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', message_timestamp) AS bucket,
  thing_name,
  AVG(cpu_pct) AS avg_cpu,
  MAX(cpu_pct) AS max_cpu
FROM telemetry_raw
GROUP BY bucket, thing_name;

-- Add refresh policy
SELECT add_continuous_aggregate_policy('cpu_hourly',
  start_offset => INTERVAL '3 hours',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '30 minutes');
```

Query the continuous aggregate — observe the data freshness.

#### Real-Time Aggregation: TimescaleDB's Merge-on-Read

By default on TimescaleDB v2.13+ the continuous aggregate above is `materialized_only = true` — it only returns pre-computed buckets. Any data newer than the last refresh job is silently excluded. Enable real-time aggregation to make the gap disappear:

```sql
ALTER MATERIALIZED VIEW cpu_hourly
  SET (timescaledb.materialized_only = false);
```

With this set, a plain `SELECT` on `cpu_hourly` is transparently rewritten by the query planner into:

```sql
-- What the planner actually executes (simplified):
SELECT * FROM <materialization_hypertable>   -- pre-computed historical buckets
UNION ALL
SELECT time_bucket('1 hour', message_timestamp), thing_name,
       AVG(cpu_pct), MAX(cpu_pct)
FROM telemetry_raw
WHERE message_timestamp > <materialization_watermark>  -- only the unrefreshed gap
GROUP BY 1, 2;
```

This is structurally identical to Hudi MoR: the materialization hypertable is the base file, the raw un-refreshed hypertable chunks are the delta log, and the query-time UNION ALL is the merge reader. The key difference is that Hudi merges at the **row level** (individual mutations), while TimescaleDB merges at the **aggregate bucket level** (the raw data in the unrefreshed window is re-aggregated on the fly).

**The `end_offset` gap and why real-time aggregation fills it:**

The refresh policy's `end_offset => INTERVAL '1 hour'` deliberately leaves the last hour un-materialized. This prevents partially-filled time buckets from being committed to the materialization — each bucket is only written once it is complete and no more writes are expected. Real-time aggregation is designed to cover exactly this gap: historical buckets come from the fast materialization hypertable; the current un-closed bucket is computed live over raw data.

```
NOW() - 3h          NOW() - 1h          NOW()
    │                    │                 │
    ├────────────────────┤─────────────────┤
    │  materialized      │   raw / live    │
    │  (fast lookup)     │   (UNION ALL)   │
                         ▲
                   materialization watermark
                   (end_offset boundary)
```

**Workshop exercise — compare aggregation freshness:**

Run the same query with real-time aggregation on vs off and observe the difference in the `latest_bucket` timestamp:

```sql
-- With materialized_only = true (default): latest bucket may be ~1h stale
SELECT MAX(bucket) AS latest_bucket FROM cpu_hourly;

-- After: ALTER ... SET (timescaledb.materialized_only = false)
-- Latest bucket now reflects data up to NOW() — the gap is gone
SELECT MAX(bucket) AS latest_bucket FROM cpu_hourly;
```

#### Aggregation Freshness: TimescaleDB Real-Time CAGG vs RisingWave MV

| Dimension | TimescaleDB CAGG (`materialized_only=false`) | RisingWave MV |
|---|---|---|
| Freshness | Current at query time — live scan covers un-refreshed window | Current continuously — MV updated incrementally on every write |
| Query latency (fresh data) | Higher — must scan + aggregate raw recent chunks | Low — always reading pre-computed state |
| Query latency (historical) | Low — pre-computed materialization hypertable | Low — pre-computed |
| Write-path cost | Near-zero — appends only; aggregation deferred | Higher — every write propagates through the MV DAG |
| Mechanism | Batch materialization + query-time UNION ALL over raw | Streaming incremental computation |
| Analogy | Hudi MoR (merge at read time, batch compact in background) | Hudi CoW with no lag (always-current base file) |

**Teaching point:** RisingWave's MV is always pre-computed — the freshness cost is paid at write time, so queries are always fast. TimescaleDB's real-time CAGG pays the freshness cost at read time — writes are cheap, but fresh queries must do extra work proportional to the size of the un-refreshed window. For this workshop's 3-device fleet the un-refreshed window is tiny and the difference is imperceptible; at production scale (300+ devices, 1 Hz) the tradeoff becomes meaningful.

**Reference:** TimescaleDB continuous aggregates: https://docs.timescale.com/use-timescale/latest/continuous-aggregates/
**Reference:** TimescaleDB real-time aggregation: https://docs.timescale.com/use-timescale/latest/continuous-aggregates/real-time-aggregates/

### Wrap-up (15 min)
- Recap the three-tier data freshness ladder: RisingWave (sub-second) → TimescaleDB (seconds) → Hudi/Athena (30–90 seconds)
- Tease Sessions 5–7 (extended): edge Kubernetes stack, simulated industrial site, HMI

---

## Session 5 — Edge Infrastructure: K3s Cluster Deployment

**Duration:** 4 hours
**Goal:** Deploy a K3s cluster across the 3 edge EC2 instances using an IoT Job, then deploy the full edge data pipeline via Helm.

> **Note on parallelism:** Step 5A (IoT Job → K3s cluster) and Step 5B (simulated sensor EC2) are kicked off in parallel in Block 2. Both must complete before Block 3.

### Block 1 (30 min) — Edge Stack Architecture Review

Walk through the full edge stack from [docs/notes/real-time-pipeline-architecture.md](notes/real-time-pipeline-architecture.md):

| Component | Role |
|---|---|
| Redpanda (3-node Raft) | Edge durable stream buffer; offline replay |
| Redpanda Connect (ingest) | MQTT → Redpanda bridge |
| Edge RisingWave | Streaming compute; materialized views; HMI live data source |
| TimescaleDB (CNPG) | Ad-hoc queries; durable time-series storage |
| MinIO | RisingWave checkpoints; Redpanda Tiered Storage target |
| Next.js HMI | P&ID-style industrial site visualization; ops metrics page; streams directly from RisingWave via SSE |

**No separate GraphQL server at the edge.** After research, the cleanest pattern for this HMI is:

- **Live sensor data (site diagram):** Next.js App Router Route Handlers open a `pg` connection directly to Edge RisingWave (PostgreSQL wire protocol via `node-postgres`), issue a `SUBSCRIBE` on the relevant materialized view using RisingWave's cursor-based subscription API (`CREATE SUBSCRIPTION` → `DECLARE CURSOR` → `FETCH` loop), and stream results to the browser as **Server-Sent Events (SSE)**. No intermediate GraphQL server, no polling overhead.
- **Ad-hoc / historical queries (Digital Ops page):** Next.js Route Handlers open a `pg` connection to TimescaleDB (also PostgreSQL wire protocol) and execute SQL queries on demand.

RisingWave's `SUBSCRIBE` statement streams incremental changes from any materialized view directly to a connected client over the PostgreSQL wire protocol. The `node-postgres` (`pg`) package connects to RisingWave out of the box — RisingWave explicitly targets PostgreSQL wire protocol v3 compatibility for broad client support.

This eliminates a sidecar process (PostGraphile would need its own container and optionally a metadata DB), reduces the edge stack by one component, and is actually lower latency because the Next.js server makes a direct PG wire call to RisingWave with no serialization layer in between.

**References:**
- RisingWave `SUBSCRIBE` docs: https://risingwavelabs.mintlify.app/delivery/subscription
- RisingWave event-driven services pattern: https://risingwave.com/blog/building-event-driven-services-risingwave-subscriptions/
- RisingWave PostgreSQL wire protocol compatibility: https://risingwave.com/blog/mcp-streaming-database-connect-ai-agents-risingwave/

### Block 2 (60 min) — Launch K3s Deployment Job + Sensor EC2 (Parallel)

**Step 5A: IoT Job → K3s cluster (launch now, runs in background)**

1. Create IoT Job targeting Thing Group `ws-{DEPLOYMENT_ID}`:
   - Job document: `deploy-k3s-v1`
   - In-progress timer: 45 minutes (well within 7-day max)
   - The handler script on the first device stands up a K3s server node; handlers on devices 2 and 3 join as agents
   - Job is ordered: device 2 and 3 handlers poll for the K3s server token (written to Parameter Store by device 1's handler)

2. Observe job status in IoT Core console as each device progresses: `IN_PROGRESS` → `SUCCEEDED`

**Reference:** IoT Jobs timeout configuration: https://docs.aws.amazon.com/iot/latest/developerguide/jobs-configurations-details.html

**Step 5B: Deploy Simulated Sensor EC2 (launch now, runs in parallel with 5A)**

A 4th EC2 instance (`t3.medium`) is deployed into the `workshop-edge` VPC subnet. Its user data runs a Python simulator that generates sensor readings representative of an industrial process site and publishes them via MQTT to the edge MQTT broker (deployed as part of the Helm stack in Block 3).

Simulated sensors:
- Pump pressure (3× pump trucks) — PSI, 1 Hz
- Slurry flow rate — BPM, 1 Hz
- Blender RPM — 1 Hz
- Wellhead treating pressure — PSI, 1 Hz
- Proppant concentration — lb/gal, 0.5 Hz
- Annular pressure — PSI, 1 Hz
- Surface treating temperature — °F, 0.2 Hz

> The sensor EC2 starts publishing after the Helm deployment in Block 3 wires up the MQTT broker.

CDK for the sensor EC2 is pre-staged in the repository under `cdk/sensor-simulator/`.

### Block 3 (60 min) — Deploy Edge Helm Stack

Once K3s is up (verify with `kubectl get nodes`):

```bash
# Set kubeconfig (retrieved from SSM Parameter Store by the K3s install job)
aws ssm get-parameter --name /workshop/{DEPLOYMENT_ID}/kubeconfig \
  --with-decryption --query Parameter.Value --output text > ~/.kube/edge-config
export KUBECONFIG=~/.kube/edge-config

# Deploy edge stack (all components in one Helm umbrella chart)
helm dependency update helm/edge-stack
helm upgrade --install edge-stack ./helm/edge-stack \
  --namespace edge --create-namespace \
  -f helm/edge-stack-values.yaml \
  --set deploymentId={DEPLOYMENT_ID}
```

This deploys: Redpanda, Redpanda Connect (MQTT ingest + MSK relay), Edge RisingWave, TimescaleDB (CNPG), MinIO, Next.js HMI.

Verify all pods are running:
```bash
kubectl get pods -n edge
```

### Block 4 (45 min) — Verify Edge Data Pipeline

1. Confirm sensor simulator EC2 is publishing (check MQTT broker logs via `kubectl logs`)
2. Check Redpanda topic `sensors.raw.*` via Redpanda Console (port-forward to local):
   ```bash
   kubectl port-forward -n edge svc/redpanda-console 8080:8080
   ```
3. Confirm RisingWave materialized views are computing (connect via `psql` port-forward)
4. Confirm WAN relay is forwarding to cloud MSK (check consumer group lag in cloud)

### Wrap-up (15 min)
- The edge stack is now live; data flows from simulated sensors → MQTT → Redpanda → RisingWave → Next.js SSE → HMI browser, and simultaneously → WAN relay → Cloud MSK → Cloud analytics
- Tease Session 6: the HMI

---

## Session 6 — HMI: The Edge Operator Interface

**Duration:** 4 hours
**Goal:** Use the Next.js HMI via port-forwarding to visualize the industrial site in real time, explore digital ops metrics, and simulate a network failure.

### Block 1 (30 min) — Port-Forward and Load the HMI

```bash
kubectl port-forward -n edge svc/hmi 3000:3000
```

Open `http://localhost:3000` in a browser.

The HMI has two pages:

1. **Site View** — P&ID-style SVG diagram of the industrial site built with [React Flow](https://reactflow.dev/) (36.9k GitHub stars, MIT license). Custom nodes represent simulated process equipment. Mousing over any component shows a live data panel fed by a Server-Sent Events stream from the Next.js server.

2. **Digital Ops View** — Operational metrics for data engineers:
   - WAN relay lag (Redpanda consumer group offset lag)
   - Edge buffer utilization (Redpanda NVMe usage %)
   - Queue depth: messages buffered at edge not yet uploaded to cloud
   - RisingWave materialized view freshness

**Live data delivery — RisingWave → SSE → browser (no GraphQL server required):**

The Next.js App Router Route Handler at `/api/live-stream` holds a `pg` connection open to Edge RisingWave, runs `CREATE SUBSCRIPTION s1 ON mv_sensor_latest WITHOUT INITIAL SNAPSHOT`, declares a cursor, and loops on `FETCH 100 FROM c1`. Each batch is flushed to the browser as an SSE event. The browser `EventSource` client receives updates and re-renders the React Flow node that owns that sensor.

This is a direct PostgreSQL wire subscription — no GraphQL layer, no polling. RisingWave's `SUBSCRIBE` statement is designed for exactly this pattern: streaming incremental materialized view changes to a client application.

**React Flow reference:** https://reactflow.dev/
**RisingWave SUBSCRIBE docs:** https://risingwavelabs.mintlify.app/delivery/subscription
**RisingWave event-driven services pattern:** https://risingwave.com/blog/building-event-driven-services-risingwave-subscriptions/

### Block 2 (60 min) — Site View Exploration

Participants explore the Site View:
- Mouse over process equipment nodes → see live sensor readings (pressure, flow rate, RPM, temperature)
- Observe nodes update in real time as simulated values change
- Discuss: this is what an HMI (Human-Machine Interface) means in an industrial context — a live graphical representation of physical equipment state

**Discussion:** Where does this data come from? Trace the path: Python simulator → MQTT → Redpanda Connect → Redpanda → RisingWave MV → Next.js SSE Route Handler → `EventSource` in the browser → React Flow node re-render.

### Block 3 (60 min) — Digital Ops Metrics + Network Failure Simulation

Navigate to the **Digital Ops View**.

**Simulate a network failure:**
1. Use EC2 console to modify the edge subnet's route table — remove the NAT gateway route (simulates WAN link down)
2. Observe in the Digital Ops View:
   - WAN relay lag counter starts climbing
   - Queue depth increases as sensor data accumulates in Redpanda
   - Site View continues updating normally — the HMI is running fully local
3. Discuss: this is the resilience story — edge-local dashboard continues even with no cloud connectivity
4. Restore the NAT gateway route
5. Observe: WAN relay catches up automatically from committed offset; queue depth returns to zero
6. Discuss: Redpanda's Kafka-compatible offset model means no data was lost; the relay simply resumes

**Reference:** Redpanda Connect WAN relay resilience: https://docs.redpanda.com/redpanda-connect/

### Block 4 (45 min) — Compare Edge vs Cloud Freshness

Port-forward simultaneously to both the edge HMI and the cloud Amplify front end (they can run in separate browser tabs):

| Dashboard | Data source | Mechanism | Expected freshness |
|---|---|---|---|
| Edge HMI — Frac Site | Edge RisingWave MV | SSE via Next.js `SUBSCRIBE` cursor | ~100–300 ms (LAN) |
| Cloud UI — RisingWave panel | Cloud RisingWave MV (`fleet_disk`) | SSE via ALB → Next.js `SUBSCRIBE` cursor | ~300–650 ms (Amazon Leo) or ~900 ms–1.4 s (geostationary) |
| Cloud UI — TimescaleDB panel | Cloud TimescaleDB hypertable | SSE via ALB → Next.js `LISTEN/NOTIFY` + 60 s window query | ~200–500 ms (WAN) |
| Cloud UI — Hudi reference tile | Static label (no live feed) | Athena console only | ~30–90 s floor; console-only |

Observe the three latency tiers side by side.

### Wrap-up (15 min)
- Recap the full architecture: from simulated sensors at the edge, through the MQTT → Redpanda → cloud pipeline, to three cloud storage tiers, all visible in two front ends
- Discuss production implications: RKE2 instead of K3s for FIPS compliance; Redpanda Enterprise for Tiered Storage; Amazon Leo as a preferred low-latency WAN path

---

## Session 7 — Capstone: Full Architecture Review and Production Path

**Duration:** 4 hours
**Goal:** Review the full deployed architecture, discuss production adaptations, and map what was built to a real-world edge operations deployment.

### Block 1 (60 min) — Architecture Walkthrough

Facilitator-led walkthrough of the complete data flow using the architecture diagram from `docs/notes/real-time-pipeline-architecture.md`. For each component, discuss:
- What it does in the workshop vs what it does in production
- What changes when moving to real edge hardware (RKE2 vs K3s, Redpanda Enterprise vs CE, real sensors vs Python simulator)
- HA model: what happens when a node fails at the edge vs in the cloud

### Block 2 (60 min) — Fleet Scale Discussion

Using the deployed fleet of 3 devices as a starting point:

- **Scaling to 10 participants:** Already handled by the DEPLOYMENT_ID namespace model — 30 IoT devices total, all independent
- **Scaling to 300 production sites:** 3,000 devices; single shared MSK cluster with per-site topic namespacing; Cloud RisingWave scales horizontally
- **Fleet Indexing at scale:** Dynamic Thing Groups for cohort targeting (e.g., all devices on firmware 2.x, all devices in a given region)
- **Cost model:** MSK dominates; `kafka.m5.large` × 2 brokers ≈ $200–250/month/slot; review the cost table from [real-time-pipeline-architecture.md](notes/real-time-pipeline-architecture.md)

### Block 3 (60 min) — Day-2 Operations Scenario

Participants run one final IoT Job that simulates a production Day-2 scenario:
- Target a Dynamic Thing Group: all devices where `device-config.reported.telemetry_interval_ms > 2000` (i.e., still on the old 0.2 Hz config)
- Job: update to 1 Hz
- Observe staged rollout with abort criteria in action

This demonstrates IoT Jobs + Device Client for fleet-level Day-2 operations at scale.

**Reference:** [docs/notes/2026-06-04-iot-stack-analysis.md](notes/2026-06-04-iot-stack-analysis.md) — full option comparison and gap analysis

### Block 4 (30 min) — Teardown

Run the provided teardown script to clean up all workshop resources:
```bash
./scripts/teardown.sh --deployment-id ws-{DEPLOYMENT_ID}
```

This destroys (in order): EKS workloads → MSK → IoT Things/Certificates → EC2 → subnets. The shared VPCs (`workshop-edge`, `workshop-cloud`) are preserved for the next session.

### Wrap-up (30 min)
- Open Q&A
- Reference architecture handout
- PoC scoping: what would Phase 1 look like in your environment? (10 lab devices, IoT Jobs + Device Client, two handler scripts, named shadows for app version + health)

---

## Key Technical Decisions — Reference

| Decision | Choice | Rationale | Source |
|---|---|---|---|
| AppSync private VPC resources | Lambda resolver (proxy) | AppSync HTTP data sources support public endpoints only | https://repost.aws/knowledge-center/appsync-access-private-resources-in-vpc |
| AppSync real-time backend publishing | HTTP POST to `/event` | No WebSocket required for publishers; subscribers use WebSocket | https://docs.aws.amazon.com/appsync/latest/eventapi/publish-http.html |
| Cloud live data delivery (RisingWave) | ALB → Next.js SSE + RisingWave `SUBSCRIBE` | API Gateway max timeout is 300 s — incompatible with long-lived SSE; ALB supports up to 4,000 s idle timeout with heartbeats | https://aws.amazon.com/about-aws/whats-new/2024/06/amazon-api-gateway-integration-timeout-limit-29-seconds/ |
| Cloud live data delivery (TimescaleDB) | ALB → Next.js SSE + PostgreSQL `LISTEN/NOTIFY` | TimescaleDB has no `SUBSCRIBE` primitive; insert trigger fires `pg_notify` on each row, Next.js Route Handler listens and re-queries a 60 s window. Achieves ~50–150 ms insert-to-browser vs ~10 s AppSync polling. Same ALB as RisingWave — no additional infrastructure. | https://www.postgresql.org/docs/current/sql-listen.html |
| Edge live data delivery (RisingWave) | Next.js SSE + RisingWave `SUBSCRIBE` | No GraphQL server needed; `node-postgres` connects directly to RisingWave via PG wire, `SUBSCRIBE` streams MV changes, Next.js Route Handler forwards as SSE | https://risingwavelabs.mintlify.app/delivery/subscription |
| Edge K8s distribution | K3s (workshop) / RKE2 (production) | K3s is fast to bootstrap for workshop; RKE2 is FIPS 140-2 validated for production | https://docs.k3s.io/ |
| Industrial site HMI visualization | React Flow | MIT license, 36.9k stars, custom SVG nodes, mouseover interaction built-in | https://reactflow.dev/ |
| IoT Jobs fleet deployment timing | 45-min in-progress timer | K3s install + join ≈ 10–20 min; 45 min gives safe margin within 7-day max | https://docs.aws.amazon.com/iot/latest/developerguide/jobs-configurations-details.html |
| MSK for IoT Rules Kafka action | Provisioned MSK only | MSK Serverless does not support SASL/SCRAM; IoT Kafka action requires Provisioned | https://docs.aws.amazon.com/iot/latest/developerguide/apache-kafka-rule-action.html |
| Hudi MoR writes from MSK | MSK Connect (Kafka Connect) + Hudi Sink Connector → Hudi MoR on S3 | MSK Connect runs the community Hudi DeltaStreamer / Sink connector directly against the MSK topic; no Spark/Glue cluster required. Hudi MoR appends delta logs on write — no base file rewrite — so new rows are queryable in Athena within seconds of the connector flush interval. | https://docs.aws.amazon.com/msk/latest/developerguide/msk-connect.html |
| Hudi over Iceberg | Hudi MoR with incremental query | Data freshness is the primary concern. Hudi's native incremental query path (beginTime cursor) lets clients pull only changed rows since last checkpoint — no full table scan at 5-second refresh cadence. Iceberg has no equivalent primitive. | https://hudi.apache.org/docs/querying_data#incremental-query |
| Fleet Provisioning | Provisioning by claim | Claim cert embedded in user data; permanent cert issued on first boot; 1-hour token expiry | https://docs.aws.amazon.com/iot/latest/developerguide/provision-wo-cert.html |

---

## Repository Structure (Planned)

```
edge-digital-ops-workshop/
├── amplify/                    # Amplify Gen 2 project root
│   ├── backend.ts              # Custom CDK constructs (MSK, EKS, IoT, Athena)
│   └── auth/                   # Cognito user pool per deployment
├── cdk/
│   ├── platform-stack/         # Shared VPCs, subnets, route tables
│   ├── participant-stack/      # Per-deployment resources (IoT, MSK, EKS, S3)
│   └── sensor-simulator/       # Session 5 sensor EC2
├── helm/
│   ├── edge-stack/             # Umbrella chart: Redpanda, RisingWave, CNPG, MinIO, HMI
│   ├── risingwave-values.yaml
│   └── rp-connect-timescaledb.yaml
├── k8s/
│   └── timescaledb-cluster.yaml
├── hmi/                        # Next.js HMI app (React Flow industrial site + Digital Ops page)
├── frontend/                   # Amplify-hosted cloud UI (device fleet, data freshness comparison)
├── scripts/
│   ├── create-workshop-user.sh
│   └── teardown.sh
├── job-scripts/                # IoT Job handler scripts (deployed to devices via Jobs)
│   ├── telemetry-v2.sh
│   ├── deploy-k3s.sh
│   └── add-shadows.sh
└── docs/
    ├── workshop-plan.md        # This file
    ├── intent.md
    └── notes/
```

---

## Gotchas and Watch-Outs

| Item | Detail |
|---|---|
| Fleet Hub EOL | Fleet Hub discontinued Oct 2025. Use IoT Device Management console directly for fleet queries. |
| Dynamic Thing Groups — eventual consistency | Group membership evaluates asynchronously. Newly registered devices may take seconds to appear. Don't rely on synchronous membership for sequenced jobs. |
| Shadow size limit | 8 KB per named shadow. Keep health telemetry in MQTT topics, not shadows. |
| Fleet Provisioning token expiry | `certificateOwnershipToken` expires 1 hour after `CreateKeysAndCertificate`. EC2 user data must run provisioning on first boot, not deferred. |
| IoT Jobs — max 10–15 pending per device | Don't queue more than 10 concurrent jobs to any device. |
| MSK Serverless incompatible with IoT Kafka action | Must use Provisioned MSK with SASL/SCRAM or mTLS. |
| Athena + Hudi MoR read amplification | MoR queries merge base files + delta logs at read time — more I/O than CoW. Schedule async compaction via a scheduled Glue job to bound amplification during the workshop. |
| Hudi incremental query `beginTime` | The `beginTime` must be an exact Hudi commit instant (e.g. `20240101000000000`). Querying with a wall-clock timestamp requires mapping to the nearest commit instant first via `SHOW TBLPROPERTIES`. |
| RisingWave `SUBSCRIBE` cursor model | RisingWave's subscription uses `CREATE SUBSCRIPTION` + `DECLARE CURSOR` + `FETCH` loop — this is a pull model, not PostgreSQL `LISTEN/NOTIFY`. The Next.js Route Handler must run the fetch loop and flush to SSE. The loop should include a short yield between fetches to avoid busy-waiting when no new rows arrive. |
| API Gateway incompatible with SSE | API Gateway HTTP and REST APIs have a hard max integration timeout of 300 s (5 min), even with a quota increase. Use an ALB for SSE connections instead. Set ALB idle timeout to 4,000 s and emit SSE heartbeat comments (`: ping`) every 30 s from the server side. Source: https://aws.amazon.com/about-aws/whats-new/2024/06/amazon-api-gateway-integration-timeout-limit-29-seconds/ |
| ALB SSE — Cognito auth | ALB supports Cognito JWT authentication natively via `authenticate-cognito` listener rule. The JWT is validated at the ALB before the request hits the Next.js server — no custom auth middleware needed in the Route Handler. |
| K3s → RKE2 for production | K3s does not have FIPS 140-2 validated cryptography out of the box. For regulated or HSE-sensitive environments, upgrade to RKE2 before production. |
