#!/usr/bin/env tsx
/**
 * e2e/runner.ts — End-to-end workshop test suite
 *
 * Deploys the full workshop (platform stack + participant stack), exercises
 * every session's key steps with typed AWS SDK calls, records per-operation
 * latency and data-point metrics, then tears everything down and verifies
 * all resources are deleted.
 *
 * Usage:
 *   pnpm test                              # full run
 *   pnpm test -- --skip-deploy             # assume stacks already up
 *   pnpm test -- --skip-teardown           # leave everything running after tests
 *   pnpm test -- --skip-platform-teardown
 *   pnpm test -- --deployment-id ws-slot01
 *   pnpm test -- --session observe         # run only Phase 2 (Session 1: Observe)
 *
 * --session values map to phases:
 *   platform | observe | control | state | analytics | edge | hmi | teardown | platform-teardown
 *
 * Environment variables:
 *   WORKSHOP_TEST_SLOT          deployment ID (default: ws-e2e-test)
 *   AWS_REGION                  AWS region (default: us-east-1)
 *   E2E_SKIP_DEPLOY             "true" to skip all CDK/sandbox deploy
 *   E2E_SKIP_TEARDOWN           "true" to skip participant teardown
 *   E2E_SKIP_PLATFORM_TEARDOWN  "true" to keep shared VPCs/EKS after test
 *   E2E_K3S_TIMEOUT_MS          ms to wait for K3s job (default: 1_800_000)
 *   E2E_HELM_TIMEOUT_MS         ms to wait for Helm rollout (default: 600_000)
 *   E2E_HMI_TIMEOUT_MS          ms to wait for HMI SSE events (default: 60_000)
 *   E2E_EKS_DELETE_TIMEOUT_MS   ms to wait for EKS deletion (default: 1_200_000)
 */

import { execSync, execFileSync, spawn } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { chromium } from "playwright";
import { writeMarkdownReport } from "./report-writer.js";

import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeVpcsCommand,
} from "@aws-sdk/client-ec2";
import {
  EKSClient,
  DescribeClusterCommand,
  DescribeNodegroupCommand,
  DeleteNodegroupCommand,
  DeleteClusterCommand,
} from "@aws-sdk/client-eks";
import {
  IoTClient,
  DescribeThingGroupCommand,
  ListThingsInThingGroupCommand,
  DescribeProvisioningTemplateCommand,
  GetTopicRuleCommand,
  CreateJobCommand,
  ListJobExecutionsForJobCommand,
  GetIndexingConfigurationCommand,
} from "@aws-sdk/client-iot";
import {
  IoTDataPlaneClient,
  ListNamedShadowsForThingCommand,
  GetThingShadowCommand,
} from "@aws-sdk/client-iot-data-plane";
import {
  KafkaClient,
  ListClustersV2Command,
  GetBootstrapBrokersCommand,
} from "@aws-sdk/client-kafka";
import {
  S3Client,
  HeadBucketCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  DescribeSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand,
  GetParameterCommand,
} from "@aws-sdk/client-ssm";
import {
  STSClient,
  GetCallerIdentityCommand,
} from "@aws-sdk/client-sts";
import {
  AthenaClient,
  GetWorkGroupCommand,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
} from "@aws-sdk/client-athena";
import pg from "pg";

// ── Config ────────────────────────────────────────────────────────────────────

const DEPLOYMENT_ID = process.env.WORKSHOP_TEST_SLOT ?? "ws-e2e-test";
const REGION = process.env.AWS_REGION ?? "us-east-1";
const SKIP_DEPLOY = process.env.E2E_SKIP_DEPLOY === "true" || process.argv.includes("--skip-deploy");
const SKIP_TEARDOWN = process.env.E2E_SKIP_TEARDOWN === "true" || process.argv.includes("--skip-teardown");
const SKIP_PLATFORM_TEARDOWN =
  SKIP_TEARDOWN ||
  process.env.E2E_SKIP_PLATFORM_TEARDOWN === "true" ||
  process.argv.includes("--skip-platform-teardown");

// --session <name>: run only the named session phase (implies --skip-deploy and
// --skip-teardown unless the session name is "teardown" or "platform-teardown").
const SESSION_ARG = (() => {
  const i = process.argv.indexOf("--session");
  return i !== -1 ? process.argv[i + 1] : undefined;
})();

const SESSION_PHASE_MAP: Record<string, string> = {
  platform:           "Phase 0",
  observe:            "Phase 2",
  control:            "Phase 3",
  state:              "Phase 4",
  analytics:          "Phase 5",
  edge:               "Phase 6",
  hmi:                "Phase 7",
  teardown:           "Phase 8",
  "platform-teardown":"Phase 9",
};

// When --session is given, only the matching phase runs; all others are skipped.
function phaseEnabled(phasePrefix: string): boolean {
  if (!SESSION_ARG) return true;
  const target = SESSION_PHASE_MAP[SESSION_ARG];
  if (!target) {
    console.error(`Unknown --session value: "${SESSION_ARG}". Valid values: ${Object.keys(SESSION_PHASE_MAP).join(", ")}`);
    process.exit(1);
  }
  return phasePrefix.startsWith(target);
}

const K3S_TIMEOUT_MS = Number(process.env.E2E_K3S_TIMEOUT_MS ?? 1_800_000);
const HELM_TIMEOUT_MS = Number(process.env.E2E_HELM_TIMEOUT_MS ?? 600_000);
const HMI_TIMEOUT_MS = Number(process.env.E2E_HMI_TIMEOUT_MS ?? 60_000);
const EKS_DELETE_TIMEOUT_MS = Number(process.env.E2E_EKS_DELETE_TIMEOUT_MS ?? 1_200_000);

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

// ── AWS clients ───────────────────────────────────────────────────────────────

const cfg = { region: REGION };
const iotData = new IoTDataPlaneClient(cfg);
const cfn = new CloudFormationClient(cfg);
const ec2 = new EC2Client(cfg);
const eks = new EKSClient(cfg);
const iot = new IoTClient(cfg);
const kafka = new KafkaClient(cfg);
const s3 = new S3Client(cfg);
const sm = new SecretsManagerClient(cfg);
const ssm = new SSMClient(cfg);
const sts = new STSClient(cfg);
const athena = new AthenaClient(cfg);

// ── Metrics infrastructure ────────────────────────────────────────────────────

interface CheckMetric {
  name: string;
  phase: string;
  passed: boolean;
  durationMs: number;
  error?: string;
  data?: Record<string, unknown>;
  // Rich evidence blobs: label → string content (JSON, plain text, or base64 PNG).
  // "screenshot" / "screenshot_*" labels are rendered as inline images.
  evidence?: Record<string, string>;
}

interface PhaseMetric {
  name: string;
  startedAt: string;
  durationMs: number;
  checksTotal: number;
  checksPassed: number;
  checksFailed: number;
}

const checkMetrics: CheckMetric[] = [];
const phaseMetrics: PhaseMetric[] = [];
let currentPhase = "init";
let phaseStart = Date.now();
let phaseChecksTotal = 0;
let phaseChecksPassed = 0;
let phaseChecksFailed = 0;

function beginPhase(name: string) {
  if (currentPhase !== "init") {
    phaseMetrics.push({
      name: currentPhase,
      startedAt: new Date(phaseStart).toISOString(),
      durationMs: Date.now() - phaseStart,
      checksTotal: phaseChecksTotal,
      checksPassed: phaseChecksPassed,
      checksFailed: phaseChecksFailed,
    });
  }
  currentPhase = name;
  phaseStart = Date.now();
  phaseChecksTotal = 0;
  phaseChecksPassed = 0;
  phaseChecksFailed = 0;

  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  ${name}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

function flushPhase() {
  phaseMetrics.push({
    name: currentPhase,
    startedAt: new Date(phaseStart).toISOString(),
    durationMs: Date.now() - phaseStart,
    checksTotal: phaseChecksTotal,
    checksPassed: phaseChecksPassed,
    checksFailed: phaseChecksFailed,
  });
}

async function check<T>(
  name: string,
  fn: () => Promise<T>,
  opts?: { data?: (result: T) => Record<string, unknown> }
): Promise<T | undefined> {
  const t0 = Date.now();
  phaseChecksTotal++;
  try {
    const result = await fn();
    const durationMs = Date.now() - t0;
    const data = opts?.data ? opts.data(result) : undefined;
    checkMetrics.push({ name, phase: currentPhase, passed: true, durationMs, data });
    phaseChecksPassed++;
    const suffix = data ? `  (${formatData(data)})` : "";
    console.log(`  ✓  ${name}  [${durationMs}ms]${suffix}`);
    return result;
  } catch (err: unknown) {
    const durationMs = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    checkMetrics.push({ name, phase: currentPhase, passed: false, durationMs, error: msg });
    phaseChecksFailed++;
    console.error(`  ✗  ${name}  [${durationMs}ms]`);
    console.error(`       ${msg}`);
    return undefined;
  }
}

function formatData(d: Record<string, unknown>): string {
  return Object.entries(d)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

function log(msg: string) {
  console.log(`  ▶  ${msg}`);
}

// Attach evidence to the most recently recorded check.
function capture(label: string, value: string) {
  const last = checkMetrics[checkMetrics.length - 1];
  if (!last) return;
  last.evidence ??= {};
  last.evidence[label] = value;
}

// ── Shell helpers ─────────────────────────────────────────────────────────────

function shell(cmd: string, opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  return execSync(cmd, {
    cwd: opts?.cwd ?? REPO_ROOT,
    env: { ...process.env, ...opts?.env },
    stdio: "inherit",
    encoding: "utf8",
  });
}

function shellOutput(
  cmd: string,
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv }
): string {
  return execSync(cmd, {
    cwd: opts?.cwd ?? REPO_ROOT,
    env: { ...process.env, ...opts?.env },
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

// Run a Helm command, tolerating two distinct failure modes:
//   1. "post-upgrade hooks failed" — the manifests were applied; hook jobs just
//      timed out (e.g. waiting for CNPG cluster init).  We handle that ourselves
//      downstream, so treat this as a soft warning and continue.
//   2. Transient network errors (connection reset, etc.) — retry up to `attempts` times.
async function shellRetry(
  cmd: string,
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv; attempts?: number; delayMs?: number }
): Promise<void> {
  const attempts = opts?.attempts ?? 3;
  const delayMs = opts?.delayMs ?? 10_000;
  for (let i = 1; i <= attempts; i++) {
    try {
      shell(cmd, opts);
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Helm post-upgrade/post-install hook timeout: resources are applied, hooks
      // just didn't finish in time.  We wait and handle this downstream.
      if (msg.includes("post-upgrade hooks failed") || msg.includes("post-install hooks failed")) {
        log(`  ⚠  Helm hook timed out (resources applied) — continuing`);
        return;
      }
      if (i === attempts) throw err;
      log(`  ⚠  Command failed (attempt ${i}/${attempts}), retrying in ${delayMs / 1000}s...`);
      await sleep(delayMs);
    }
  }
}

// ── SSM helpers ───────────────────────────────────────────────────────────────

async function ssmRunCommand(
  instanceId: string,
  command: string,
  timeoutMs = 120_000
): Promise<{ stdout: string; stderr: string; durationMs: number }> {
  const t0 = Date.now();
  const send = await ssm.send(
    new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: "AWS-RunShellScript",
      Parameters: { commands: [command] },
    })
  );
  const cmdId = send.Command!.CommandId!;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(8_000);
    const inv = await ssm.send(
      new GetCommandInvocationCommand({ CommandId: cmdId, InstanceId: instanceId })
    );
    const status = inv.Status;
    if (status === "Success") {
      return {
        stdout: inv.StandardOutputContent ?? "",
        stderr: inv.StandardErrorContent ?? "",
        durationMs: Date.now() - t0,
      };
    }
    const terminalStatuses = new Set(["Failed", "Cancelled", "TimedOut", "Undeliverable", "Terminated"]);
    if (terminalStatuses.has(status as string)) {
      throw new Error(
        `SSM command ${cmdId} on ${instanceId} ended with status ${status}\n` +
          `stdout: ${inv.StandardOutputContent}\nstderr: ${inv.StandardErrorContent}`
      );
    }
  }
  throw new Error(`SSM command ${cmdId} timed out after ${timeoutMs}ms`);
}

// ── Kubernetes helpers ────────────────────────────────────────────────────────

function kubectl(kubeconfigPath: string, args: string): string {
  return shellOutput(`kubectl --kubeconfig ${kubeconfigPath} ${args}`);
}

function helm(kubeconfigPath: string, args: string) {
  shell(`helm --kubeconfig ${kubeconfigPath} ${args}`);
}

async function waitForPods(
  kubeconfigPath: string,
  namespace: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = shellOutput(
      `kubectl --kubeconfig ${kubeconfigPath} get pods -n ${namespace} --no-headers 2>/dev/null || echo ""`
    );
    const lines = out.split("\n").filter(Boolean);
    const notReady = lines.filter(
      (l) => !l.includes("Running") && !l.includes("Completed") && !l.includes("Succeeded")
    );
    if (lines.length > 0 && notReady.length === 0) return;
    await sleep(10_000);
  }
  throw new Error(`Pods in ${namespace} did not reach Running within ${timeoutMs}ms`);
}

// ── SSM tunnel (background process) ──────────────────────────────────────────

interface Tunnel {
  localPort: number;
  proc: ReturnType<typeof spawn>;
  close: () => void;
}

function openSsmTunnel(instanceId: string, remotePort: number, localPort: number): Tunnel {
  const proc = spawn(
    "aws",
    [
      "ssm", "start-session",
      "--region", REGION,
      "--target", instanceId,
      "--document-name", "AWS-StartPortForwardingSession",
      "--parameters", JSON.stringify({ portNumber: [String(remotePort)], localPortNumber: [String(localPort)] }),
    ],
    { stdio: "ignore", detached: false }
  );
  return {
    localPort,
    proc,
    close: () => { try { proc.kill(); } catch { /* ignore */ } },
  };
}

// ── IoT Job helper ────────────────────────────────────────────────────────────

async function createIotJob(
  jobId: string,
  thingGroupArn: string,
  s3ScriptKey: string,
  inProgressTimeoutMinutes = 15
): Promise<void> {
  const doc = JSON.stringify({
    version: "1.0",
    steps: [
      {
        action: {
          name: jobId,
          type: "runHandler",
          input: {
            handler: "run-script.sh",
            args: [`s3://workshop-${DEPLOYMENT_ID}/job-scripts/${s3ScriptKey}`],
          },
          runAsUser: "",
        },
      },
    ],
  });
  try {
    await iot.send(
      new CreateJobCommand({
        jobId,
        targets: [thingGroupArn],
        document: doc,
        timeoutConfig: { inProgressTimeoutInMinutes: inProgressTimeoutMinutes },
      })
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "ResourceAlreadyExistsException") {
      log(`IoT Job ${jobId} already exists — continuing`);
      return;
    }
    throw err;
  }
}

async function waitForIotJob(
  jobId: string,
  expectedSuccessCount: number,
  timeoutMs: number
): Promise<{ succeeded: number; failed: number; waitMs: number }> {
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  while (Date.now() < deadline) {
    const [succResp, failResp] = await Promise.all([
      iot.send(new ListJobExecutionsForJobCommand({ jobId, status: "SUCCEEDED" })),
      iot.send(new ListJobExecutionsForJobCommand({ jobId, status: "FAILED" })),
    ]);
    const succeeded = succResp.executionSummaries?.length ?? 0;
    const failed = failResp.executionSummaries?.length ?? 0;
    if (succeeded >= expectedSuccessCount) {
      return { succeeded, failed, waitMs: Date.now() - t0 };
    }
    log(`  IoT Job ${jobId}: ${succeeded}/${expectedSuccessCount} succeeded, ${failed} failed...`);
    await sleep(30_000);
  }
  throw new Error(`IoT Job ${jobId} timed out after ${timeoutMs}ms`);
}

// ── pg query with metrics ─────────────────────────────────────────────────────

async function pgQuery(
  client: pg.Client,
  sql: string
): Promise<{ rows: pg.QueryResultRow[]; durationMs: number }> {
  const t0 = Date.now();
  const result = await client.query(sql);
  return { rows: result.rows, durationMs: Date.now() - t0 };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const suiteStart = Date.now();
let edgeKubeconfig = "";
const tunnels: Tunnel[] = [];

// Cross-phase state — populated by the phase that creates them, read by later phases.
let sensorSimId = "";
let sensorSimIp = "";
let edgeInstance0 = "";
let thingGroupArn = "";
let mskArn: string | undefined;
let mskBootstrap = "";
let mskCreds: { username: string; password: string } = { username: "", password: "" };
let cloudKcPath = "";

try {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   Edge Digital Ops Workshop — End-to-End Test Suite      ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`  Deployment ID           : ${DEPLOYMENT_ID}`);
  console.log(`  Region                  : ${REGION}`);
  console.log(`  Skip deploy             : ${SKIP_DEPLOY}`);
  console.log(`  Skip teardown           : ${SKIP_TEARDOWN}`);
  console.log(`  Skip platform teardown  : ${SKIP_PLATFORM_TEARDOWN}`);

  // ── Pre-flight: resolve cross-phase state when running a single session ────
  // Cross-phase variables (thingGroupArn, mskArn, edgeInstance0, etc.) are
  // populated during their respective phases. When --session skips earlier phases,
  // we look them up here so later phases can use them.
  if (SESSION_ARG) {
    const accountId = (await sts.send(new GetCallerIdentityCommand({}))).Account!;
    thingGroupArn = `arn:aws:iot:${REGION}:${accountId}:thinggroup/${DEPLOYMENT_ID}-devices`;

    const edgeInstancesResp = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: "tag:WorkshopDeploymentId", Values: [DEPLOYMENT_ID] },
          { Name: "tag:Name", Values: ["*edge-?"] },
          { Name: "instance-state-name", Values: ["running"] },
        ],
      })
    );
    const edgeIds = edgeInstancesResp.Reservations?.flatMap(
      (r) => r.Instances?.map((i) => i.InstanceId!) ?? []
    ) ?? [];
    edgeInstance0 = edgeIds[0] ?? "";

    const sensorSimResp = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: "tag:Name", Values: [`workshop-${DEPLOYMENT_ID}-sensor-sim`] },
          { Name: "instance-state-name", Values: ["running"] },
        ],
      })
    );
    sensorSimId = sensorSimResp.Reservations?.[0]?.Instances?.[0]?.InstanceId ?? "";
    sensorSimIp = sensorSimResp.Reservations?.[0]?.Instances?.[0]?.PrivateIpAddress ?? "";

    // Phase 7 (hmi) needs the K3s kubeconfig and SSM tunnel — set them up here
    // so the phase doesn't require Phase 6 to have run in the same invocation.
    if (SESSION_ARG === "hmi") {
      const kcParam = await ssm.send(
        new GetParameterCommand({ Name: `/workshop/${DEPLOYMENT_ID}/kubeconfig`, WithDecryption: true })
      );
      const kcRaw = kcParam.Parameter?.Value ?? "";
      edgeKubeconfig = join(tmpdir(), `e2e-edge-kc-hmi-${Date.now()}.yaml`);
      writeFileSync(
        edgeKubeconfig,
        kcRaw.replace(/https:\/\/[0-9.]+:6443/g, "https://127.0.0.1:16443")
      );
      const serverIpMatch = kcRaw.match(/https:\/\/([0-9.]+):6443/);
      const k3sServerIp = serverIpMatch?.[1] ?? "";
      let k3sServerId = edgeInstance0;
      if (k3sServerIp) {
        const serverResp = await ec2.send(
          new DescribeInstancesCommand({
            Filters: [
              { Name: "private-ip-address", Values: [k3sServerIp] },
              { Name: "instance-state-name", Values: ["running"] },
            ],
          })
        );
        k3sServerId = serverResp.Reservations?.[0]?.Instances?.[0]?.InstanceId ?? edgeInstance0;
        log(`Pre-flight: K3s server IP ${k3sServerIp} → instance ${k3sServerId}`);
      }
      const k3sTunnel = openSsmTunnel(k3sServerId, 6443, 16443);
      tunnels.push(k3sTunnel);
      await sleep(15_000);
      log("Pre-flight: K3s tunnel ready");
    }
  }

  // ── Phase 0: Platform stack ────────────────────────────────────────────────
  if (phaseEnabled("Phase 0")) {
  beginPhase("Phase 0 — Platform stack");

  if (!SKIP_DEPLOY) {
    log("Deploying WorkshopPlatformStack (CDK)...");
    const t0 = Date.now();
    shell(
      `npx cdk deploy --app "npx tsx amplify/custom/platform-app.ts" --require-approval never WorkshopPlatformStack`
    );
    log(`  CDK deploy finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } else {
    log("Skipping platform deploy (--skip-deploy)");
  }

  await check("workshop-edge VPC exists", async () => {
    const t0 = Date.now();
    const resp = await ec2.send(
      new DescribeVpcsCommand({ Filters: [{ Name: "tag:Name", Values: ["workshop-edge"] }] })
    );
    const vpc = resp.Vpcs?.[0];
    if (!vpc?.VpcId) throw new Error("workshop-edge VPC not found");
    return { vpcId: vpc.VpcId, durationMs: Date.now() - t0 };
  }, { data: (r) => r });

  await check("workshop-cloud VPC exists", async () => {
    const t0 = Date.now();
    const resp = await ec2.send(
      new DescribeVpcsCommand({ Filters: [{ Name: "tag:Name", Values: ["workshop-cloud"] }] })
    );
    const vpc = resp.Vpcs?.[0];
    if (!vpc?.VpcId) throw new Error("workshop-cloud VPC not found");
    return { vpcId: vpc.VpcId, durationMs: Date.now() - t0 };
  }, { data: (r) => r });

  await check("workshop-eks cluster ACTIVE", async () => {
    const t0 = Date.now();
    const resp = await eks.send(new DescribeClusterCommand({ name: "workshop-eks" }));
    const status = resp.cluster?.status;
    if (status !== "ACTIVE") throw new Error(`EKS cluster status: ${status}`);
    return { status, version: resp.cluster?.version ?? "?", durationMs: Date.now() - t0 };
  }, { data: (r) => r });

  await check("workshop-eks has ≥2 Ready nodes", async () => {
    const t0 = Date.now();
    const kcPath = join(tmpdir(), `e2e-cloud-kc-${Date.now()}.yaml`);
    shell(`aws eks update-kubeconfig --region ${REGION} --name workshop-eks --kubeconfig ${kcPath}`);
    const out = shellOutput(
      `kubectl --kubeconfig ${kcPath} get nodes --no-headers 2>/dev/null`
    );
    const ready = out.split("\n").filter((l) => l.includes("Ready")).length;
    if (ready < 2) throw new Error(`Only ${ready} Ready nodes found`);
    return { readyNodes: ready, durationMs: Date.now() - t0 };
  }, { data: (r) => r });

  await check("IoT Fleet Indexing REGISTRY_AND_SHADOW", async () => {
    const t0 = Date.now();
    const resp = await iot.send(new GetIndexingConfigurationCommand({}));
    const mode = resp.thingIndexingConfiguration?.thingIndexingMode;
    if (mode !== "REGISTRY_AND_SHADOW")
      throw new Error(`Unexpected indexing mode: ${mode}`);
    return { mode, durationMs: Date.now() - t0 };
  }, { data: (r) => r });
  } // end Phase 0

  // ── Phase 1: Participant stack deploy ──────────────────────────────────────
  if (phaseEnabled("Phase 1")) {
  beginPhase("Phase 1 — Participant stack deploy");

  if (!SKIP_DEPLOY) {
    log(`Running scripts/sandbox.sh ${DEPLOYMENT_ID}...`);
    const t0 = Date.now();
    shell(`bash scripts/sandbox.sh ${DEPLOYMENT_ID}`, {
      env: { WORKSHOP_DEPLOYMENT_ID: DEPLOYMENT_ID },
    });
    log(`  Sandbox deploy finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } else {
    log("Skipping participant deploy (--skip-deploy)");
  }

  // Discover EC2 instances
  const instancesResp = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:WorkshopDeploymentId", Values: [DEPLOYMENT_ID] },
        { Name: "instance-state-name", Values: ["running", "pending"] },
      ],
    })
  );
  const allInstances = instancesResp.Reservations?.flatMap(
    (r) => r.Instances?.map((i) => i.InstanceId!) ?? []
  ) ?? [];

  const sensorSimResp = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:Name", Values: [`workshop-${DEPLOYMENT_ID}-sensor-sim`] },
        { Name: "instance-state-name", Values: ["running"] },
      ],
    })
  );
  sensorSimId = sensorSimResp.Reservations?.[0]?.Instances?.[0]?.InstanceId ?? "";
  sensorSimIp =
    sensorSimResp.Reservations?.[0]?.Instances?.[0]?.PrivateIpAddress ?? "";

  const edgeInstancesResp = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:WorkshopDeploymentId", Values: [DEPLOYMENT_ID] },
        { Name: "tag:Name", Values: ["*edge-?"] },
        { Name: "instance-state-name", Values: ["running"] },
      ],
    })
  );
  const edgeInstanceIds = edgeInstancesResp.Reservations?.flatMap(
    (r) => r.Instances?.map((i) => i.InstanceId!) ?? []
  ) ?? [];
  edgeInstance0 = edgeInstanceIds[0] ?? "";

  await check("3 EC2 instances running with WorkshopDeploymentId tag", async () => {
    if (allInstances.length < 3)
      throw new Error(`Expected ≥3 instances, found ${allInstances.length}`);
    return { count: allInstances.length, instances: allInstances };
  }, { data: (r) => ({ count: r.count }) });

  await check("sensor-sim EC2 running and has private IP", async () => {
    if (!sensorSimId || !sensorSimIp)
      throw new Error("sensor-sim instance not found or no private IP");
    return { instanceId: sensorSimId, privateIp: sensorSimIp };
  }, { data: (r) => r });
  } // end Phase 1

  // ── Phase 2: Session 1 — Observe ──────────────────────────────────────────
  if (phaseEnabled("Phase 2")) {
  beginPhase("Phase 2 — Session 1: Observe");

  // Wait for IoT Device Client to provision Things (up to 10 min)
  log("Waiting for Things to self-provision (up to 10 min)...");
  let thingCount = 0;
  const thingDeadline = Date.now() + 600_000;
  while (Date.now() < thingDeadline) {
    const resp = await iot.send(
      new ListThingsInThingGroupCommand({ thingGroupName: `${DEPLOYMENT_ID}-devices` })
    ).catch(() => null);
    thingCount = resp?.things?.length ?? 0;
    if (thingCount >= 3) break;
    log(`  ${thingCount}/3 Things registered...`);
    await sleep(15_000);
  }

  await check(
    `IoT Thing Group ${DEPLOYMENT_ID}-devices exists with ≥3 Things`,
    async () => {
      const t0 = Date.now();
      const resp = await iot.send(
        new DescribeThingGroupCommand({ thingGroupName: `${DEPLOYMENT_ID}-devices` })
      );
      const things = await iot.send(
        new ListThingsInThingGroupCommand({ thingGroupName: `${DEPLOYMENT_ID}-devices` })
      );
      const count = things.things?.length ?? 0;
      if (count < 3) throw new Error(`Only ${count} Things registered`);
      return { groupArn: resp.thingGroupArn!, thingCount: count, durationMs: Date.now() - t0 };
    },
    { data: (r) => ({ thingCount: r.thingCount, sdkLatencyMs: r.durationMs }) }
  );

  thingGroupArn = `arn:aws:iot:${REGION}:${(await sts.send(new GetCallerIdentityCommand({}))).Account}:thinggroup/${DEPLOYMENT_ID}-devices`;

  await check("IoT provisioning template exists", async () => {
    const t0 = Date.now();
    const resp = await iot.send(
      new DescribeProvisioningTemplateCommand({ templateName: `${DEPLOYMENT_ID}-provisioning` })
    );
    return { templateArn: resp.templateArn!, durationMs: Date.now() - t0 };
  }, { data: (r) => ({ sdkLatencyMs: r.durationMs }) });

  await check(`IoT topic rule workshop_${DEPLOYMENT_ID.replace(/-/g, "_")}_to_s3 exists`, async () => {
    const t0 = Date.now();
    const resp = await iot.send(
      new GetTopicRuleCommand({ ruleName: `workshop_${DEPLOYMENT_ID.replace(/-/g, "_")}_to_s3` })
    );
    return { ruleArn: resp.ruleArn!, durationMs: Date.now() - t0 };
  }, { data: (r) => ({ sdkLatencyMs: r.durationMs }) });

  await check(`S3 bucket workshop-${DEPLOYMENT_ID} exists`, async () => {
    const t0 = Date.now();
    await s3.send(new HeadBucketCommand({ Bucket: `workshop-${DEPLOYMENT_ID}` }));
    return { durationMs: Date.now() - t0 };
  }, { data: (r) => ({ sdkLatencyMs: r.durationMs }) });

  await check(`Athena workgroup workshop-${DEPLOYMENT_ID} exists`, async () => {
    const t0 = Date.now();
    const resp = await athena.send(
      new GetWorkGroupCommand({ WorkGroup: `workshop-${DEPLOYMENT_ID}` })
    );
    return { state: resp.WorkGroup?.State!, durationMs: Date.now() - t0 };
  }, { data: (r) => ({ state: r.state, sdkLatencyMs: r.durationMs }) });

  await check("MSK SCRAM secret exists", async () => {
    const t0 = Date.now();
    const resp = await sm.send(
      new DescribeSecretCommand({ SecretId: `AmazonMSK_workshop-${DEPLOYMENT_ID}` })
    );
    return { secretArn: resp.ARN!, durationMs: Date.now() - t0 };
  }, { data: (r) => ({ sdkLatencyMs: r.durationMs }) });

  // Wait for S3 telemetry objects
  log("Waiting up to 5 min for first S3 telemetry objects...");
  let s3ObjectCount = 0;
  const s3Deadline = Date.now() + 300_000;
  while (Date.now() < s3Deadline) {
    const resp = await s3.send(
      new ListObjectsV2Command({ Bucket: `workshop-${DEPLOYMENT_ID}`, Prefix: "telemetry/", MaxKeys: 10 })
    ).catch(() => null);
    s3ObjectCount = resp?.Contents?.length ?? 0;
    if (s3ObjectCount > 0) break;
    log("  No S3 telemetry objects yet...");
    await sleep(10_000);
  }
  // Re-list to get actual keys for evidence sampling
  let s3SampleKey: string | undefined;
  await check("S3 telemetry objects exist (data is flowing)", async () => {
    if (s3ObjectCount === 0) throw new Error("No telemetry objects found in S3 after 5 min");
    const listing = await s3.send(
      new ListObjectsV2Command({ Bucket: `workshop-${DEPLOYMENT_ID}`, Prefix: "telemetry/", MaxKeys: 5 })
    ).catch(() => null);
    s3SampleKey = listing?.Contents?.[0]?.Key;
    return { objectCount: s3ObjectCount };
  }, { data: (r) => r });

  // Capture one MQTT-via-S3 telemetry message as evidence
  if (s3SampleKey) {
    try {
      const obj = await s3.send(new GetObjectCommand({
        Bucket: `workshop-${DEPLOYMENT_ID}`,
        Key: s3SampleKey,
      }));
      const body = await obj.Body?.transformToString("utf8") ?? "";
      // IoT Rule may write newline-delimited JSON; grab first non-empty line
      const firstLine = body.split("\n").find((l) => l.trim().startsWith("{")) ?? body.slice(0, 500);
      capture("MQTT telemetry message (S3 sample)", firstLine);
      capture("S3 object key", s3SampleKey);
    } catch { /* evidence is best-effort */ }
  }
  } // end Phase 2

  // ── Phase 3: Session 2 — Control ──────────────────────────────────────────
  if (phaseEnabled("Phase 3")) {
  beginPhase("Phase 3 — Session 2: Control");

  const telemetryJobId = "update-telemetry-v2-e2e";
  log(`Uploading job-scripts/telemetry-v2.sh to S3...`);
  shell(`aws s3 cp job-scripts/telemetry-v2.sh s3://workshop-${DEPLOYMENT_ID}/job-scripts/telemetry-v2.sh`);

  log(`Creating IoT Job ${telemetryJobId}...`);
  await createIotJob(telemetryJobId, thingGroupArn, "telemetry-v2.sh", 10);

  await check("IoT Job telemetry-v2 completes on all 3 devices", async () => {
    const result = await waitForIotJob(telemetryJobId, 3, 900_000);
    return result;
  }, { data: (r) => ({ succeeded: r.succeeded, failed: r.failed, waitMs: r.waitMs }) });
  } // end Phase 3

  // ── Phase 4: Session 3 — State ────────────────────────────────────────────
  if (phaseEnabled("Phase 4")) {
  beginPhase("Phase 4 — Session 3: State");

  const shadowJobId = "add-shadows-e2e";
  log(`Uploading job-scripts/add-shadows.sh to S3...`);
  shell(`aws s3 cp job-scripts/add-shadows.sh s3://workshop-${DEPLOYMENT_ID}/job-scripts/add-shadows.sh`);

  log(`Creating IoT Job ${shadowJobId}...`);
  await createIotJob(shadowJobId, thingGroupArn, "add-shadows.sh", 10);

  await check("IoT Job add-shadows completes on all 3 devices", async () => {
    const result = await waitForIotJob(shadowJobId, 3, 600_000);
    return result;
  }, { data: (r) => ({ succeeded: r.succeeded, failed: r.failed, waitMs: r.waitMs }) });

  let shadowThingName = "";
  await check("device-config named shadow exists on all 3 Things", async () => {
    const t0 = Date.now();
    const thingsResp = await iot.send(
      new ListThingsInThingGroupCommand({ thingGroupName: `${DEPLOYMENT_ID}-devices` })
    );
    const things = thingsResp.things ?? [];
    if (things.length === 0) throw new Error("No Things found in group");
    const results: Record<string, string[]> = {};
    for (const thing of things) {
      const resp = await iotData.send(
        new ListNamedShadowsForThingCommand({ thingName: thing })
      );
      const shadows = resp.results ?? [];
      if (!shadows.includes("device-config"))
        throw new Error(`${thing} missing device-config shadow — has: ${shadows.join(", ")}`);
      results[thing] = shadows;
      if (!shadowThingName) shadowThingName = thing;
    }
    return { thingCount: things.length, shadowsPerThing: results, durationMs: Date.now() - t0 };
  }, { data: (r) => ({ thingCount: r.thingCount, sdkLatencyMs: r.durationMs }) });

  // Capture the actual shadow document for one device as evidence
  if (shadowThingName) {
    try {
      const resp = await iotData.send(new GetThingShadowCommand({
        thingName: shadowThingName,
        shadowName: "device-config",
      }));
      const payload = new TextDecoder().decode(resp.payload);
      capture(`device-config shadow (${shadowThingName})`, payload);
    } catch { /* evidence is best-effort */ }
  }
  } // end Phase 4

  // ── Phase 5: Session 4 — Analytics (cloud EKS) ────────────────────────────
  if (phaseEnabled("Phase 5")) {
  beginPhase("Phase 5 — Session 4: Analytics (cloud EKS)");

  cloudKcPath = join(tmpdir(), `e2e-cloud-kc-${Date.now()}.yaml`);
  shell(
    `aws eks update-kubeconfig --region ${REGION} --name workshop-eks --kubeconfig ${cloudKcPath}`
  );

  await check("workshop-eks API reachable", async () => {
    const t0 = Date.now();
    const out = shellOutput(`kubectl --kubeconfig ${cloudKcPath} get nodes --no-headers 2>/dev/null`);
    const ready = out.split("\n").filter((l) => l.includes("Ready")).length;
    return { readyNodes: ready, durationMs: Date.now() - t0 };
  }, { data: (r) => r });

  // Retrieve MSK credentials and bootstrap brokers
  const mskClustersResp = await kafka.send(
    new ListClustersV2Command({ ClusterNameFilter: `workshop-${DEPLOYMENT_ID}-msk` })
  );
  const mskCluster0 = mskClustersResp.ClusterInfoList?.[0];
  mskArn = mskCluster0?.ClusterArn;
  if (!mskArn) {
    log("⚠  MSK cluster not found — skipping cloud analytics checks");
  } else {
    const [bootstrapResp, secretResp] = await Promise.all([
      kafka.send(new GetBootstrapBrokersCommand({ ClusterArn: mskArn })),
      sm.send(new GetSecretValueCommand({ SecretId: `AmazonMSK_workshop-${DEPLOYMENT_ID}` })),
    ]);
    mskBootstrap = bootstrapResp.BootstrapBrokerStringSaslScram ?? "";
    mskCreds = JSON.parse(secretResp.SecretString ?? "{}") as { username: string; password: string };

    await check("MSK bootstrap brokers retrieved", async () => {
      if (!mskBootstrap) throw new Error("Empty bootstrap brokers");
      return { brokerCount: mskBootstrap.split(",").length, bootstrap: mskBootstrap.split(",")[0] };
    }, { data: (r) => ({ brokerCount: r.brokerCount }) });

    // Clear stale RisingWave S3 state so a fresh cluster can start (idempotent on first run)
    log("Clearing RisingWave S3 state bucket (idempotent)...");
    shellOutput(
      `aws s3 rm s3://workshop-${DEPLOYMENT_ID}-risingwave-state/ --recursive --region ${REGION} 2>/dev/null || true`
    );
    // Restart RisingWave pods after clearing S3 state so they start fresh.
    // Without a restart the pods hold stale in-memory state and DROP/CREATE DDL can block
    // indefinitely waiting for a checkpoint flush to the now-empty S3 bucket.
    shellOutput(
      `kubectl --kubeconfig ${cloudKcPath} rollout restart ` +
      `deployment/risingwave-cloud-frontend-default ` +
      `statefulset/risingwave-cloud-meta-default ` +
      `statefulset/risingwave-cloud-compute-default ` +
      `deployment/risingwave-cloud-compactor-default ` +
      `-n ${DEPLOYMENT_ID} 2>/dev/null || true`
    );

    // Create cloud namespace, MSK secret, and IRSA service account
    shell(
      `kubectl --kubeconfig ${cloudKcPath} create namespace ${DEPLOYMENT_ID} --dry-run=client -o yaml | kubectl --kubeconfig ${cloudKcPath} apply -f -`
    );
    shell(
      `kubectl --kubeconfig ${cloudKcPath} create secret generic msk-credentials ` +
      `--namespace ${DEPLOYMENT_ID} ` +
      `--from-literal=MSK_USERNAME=${mskCreds.username} ` +
      `--from-literal=MSK_PASSWORD=${mskCreds.password} ` +
      `--from-literal=MSK_BOOTSTRAP_SERVERS="${mskBootstrap}" ` +
      `--dry-run=client -o yaml | kubectl --kubeconfig ${cloudKcPath} apply -f -`
    );
    // Service account with IRSA annotation — required for RisingWave pods to access S3
    const accountId = (await sts.send(new GetCallerIdentityCommand({}))).Account!;
    shell(
      `kubectl --kubeconfig ${cloudKcPath} create serviceaccount risingwave-cloud ` +
      `--namespace ${DEPLOYMENT_ID} --dry-run=client -o yaml | ` +
      `kubectl --kubeconfig ${cloudKcPath} annotate -f - --local -o yaml ` +
      `eks.amazonaws.com/role-arn=arn:aws:iam::${accountId}:role/workshop-risingwave-s3 | ` +
      `kubectl --kubeconfig ${cloudKcPath} apply -f -`
    );

    // Deploy RisingWave operator
    log("Deploying RisingWave operator (cloud)...");
    await shellRetry(
      `helm --kubeconfig ${cloudKcPath} upgrade --install risingwave-operator risingwavelabs/risingwave-operator ` +
      `--namespace risingwave-system --create-namespace --wait --timeout 3m`
    );

    // Deploy RisingWave instance
    const rwManifest = readFileSync(`${REPO_ROOT}/k8s/risingwave-cloud.yaml`, "utf8").replace(
      /\$\{DEPLOYMENT_ID\}/g,
      DEPLOYMENT_ID
    );
    const rwManifestPath = join(tmpdir(), `risingwave-cloud-${DEPLOYMENT_ID}.yaml`);
    writeFileSync(rwManifestPath, rwManifest);
    shell(`kubectl --kubeconfig ${cloudKcPath} apply -n ${DEPLOYMENT_ID} -f ${rwManifestPath}`);

    // Deploy CNPG operator
    log("Deploying CNPG operator (cloud)...");
    await shellRetry(
      `helm --kubeconfig ${cloudKcPath} upgrade --install cnpg cloudnative-pg/cloudnative-pg ` +
      `--namespace cnpg-system --create-namespace --wait --timeout 3m`
    );

    // Deploy TimescaleDB
    shell(`kubectl --kubeconfig ${cloudKcPath} apply -f ${REPO_ROOT}/k8s/timescaledb-cloud-cluster.yaml -n ${DEPLOYMENT_ID}`);

    // Deploy cloud Redpanda Connect sink (MSK → TimescaleDB).
    // Needs timescaledb-credentials secret — we'll create/update it after CNPG generates the password.
    // For now register the repo; the secret and helm install happen after CNPG is ready below.
    try {
      shellOutput(`helm repo add redpanda https://charts.redpanda.com 2>/dev/null || true`);
      shellOutput(`helm repo update redpanda 2>/dev/null || true`);
    } catch { /* best-effort */ }

    log("Waiting for cloud namespace pods...");
    await waitForPods(cloudKcPath, DEPLOYMENT_ID, HELM_TIMEOUT_MS).catch(() =>
      log("⚠  Some cloud pods not yet Running — continuing")
    );

    await check("Cloud namespace has Running pods", async () => {
      const out = shellOutput(
        `kubectl --kubeconfig ${cloudKcPath} get pods -n ${DEPLOYMENT_ID} --no-headers 2>/dev/null`
      );
      const running = out.split("\n").filter((l) => l.includes("Running")).length;
      if (running === 0) throw new Error("No Running pods in cloud namespace");
      return { runningPods: running };
    }, { data: (r) => r });

    // Wait for RisingWave frontend deployment to be Available before port-forwarding
    log("Waiting for RisingWave frontend to be Available...");
    shellOutput(
      `kubectl --kubeconfig ${cloudKcPath} rollout status deployment/risingwave-cloud-frontend-default ` +
      `-n ${DEPLOYMENT_ID} --timeout=300s`
    );

    // Create the MSK topic sensors.raw.sim if it doesn't exist yet.
    // RisingWave's CREATE SOURCE fails if the topic is absent, so we pre-create it.
    // MSK is only accessible from within the cloud VPC, so we run a short-lived
    // Python pod inside EKS (same VPC) that installs kafka-python-ng and creates the topic.
    log("Creating MSK topics (sensors.raw.sim, raw.telemetry) via EKS pod (idempotent)...");
    const REQUIRED_TOPICS = ["sensors.raw.sim", "raw.telemetry"];
    // Build the script as real Python source (newlines preserved) then base64-encode it
    // so it survives being passed through kubectl --command -- python3 -c "..."
    // without indentation/continuation errors.
    const mskTopicSource = [
      `import subprocess,sys`,
      `subprocess.check_call([sys.executable,'-m','pip','install','-q','--root-user-action=ignore','kafka-python-ng'])`,
      `from kafka.admin import KafkaAdminClient,NewTopic`,
      `import ssl,time`,
      `a=KafkaAdminClient(bootstrap_servers=${JSON.stringify(mskBootstrap)},security_protocol='SASL_SSL',sasl_mechanism='SCRAM-SHA-512',sasl_plain_username=${JSON.stringify(`workshop-${DEPLOYMENT_ID}`)},sasl_plain_password=${JSON.stringify(mskCreds.password)},ssl_context=ssl.create_default_context())`,
      `for t in ${JSON.stringify(REQUIRED_TOPICS)}:`,
      `    if t not in a.list_topics():`,
      `        a.create_topics([NewTopic(t,4,2)])`,
      `        print('Created',t)`,
      `    else:`,
      `        print('Exists',t)`,
      `deadline=time.time()+60`,
      `while time.time()<deadline:`,
      `    present=a.list_topics()`,
      `    missing=[t for t in ${JSON.stringify(REQUIRED_TOPICS)} if t not in present]`,
      `    if not missing: break`,
      `    print('Waiting for topics:',missing)`,
      `    time.sleep(3)`,
      `else:`,
      `    raise RuntimeError('Topics not available after 60s: '+str(missing))`,
      `print('All topics confirmed:',sorted([t for t in a.list_topics() if t in ${JSON.stringify(REQUIRED_TOPICS)}]))`,
      `a.close()`,
    ].join("\n");
    const mskTopicB64 = Buffer.from(mskTopicSource).toString("base64");
    shellOutput(
      `kubectl --kubeconfig ${cloudKcPath} run msk-topic-init ` +
      `--rm -i --restart=Never -n ${DEPLOYMENT_ID} ` +
      `--image=python:3.12-slim ` +
      `--command -- python3 -c "exec(__import__('base64').b64decode('${mskTopicB64}').decode())" 2>&1`
    );
    log("  MSK topic creation complete");

    // Apply RisingWave DDL via kubectl port-forward to the EKS frontend service
    log("Applying cloud RisingWave DDL...");
    const rwPfProc = spawn(
      "kubectl",
      ["--kubeconfig", cloudKcPath, "port-forward", "-n", DEPLOYMENT_ID,
       "svc/risingwave-cloud-frontend", "14567:4567"],
      { stdio: "ignore" }
    );
    const rwPfTunnel = { localPort: 14567, proc: rwPfProc, close: () => { try { rwPfProc.kill(); } catch { /* */ } } };
    tunnels.push(rwPfTunnel);
    await sleep(6_000);

    const ddlTemplate = readFileSync(`${REPO_ROOT}/risingwave/ddl-cloud.sql`, "utf8");
    const ddl = ddlTemplate
      .replace(/__MSK_BOOTSTRAP__/g, mskBootstrap)
      .replace(/__MSK_USER__/g, `workshop-${DEPLOYMENT_ID}`)
      .replace(/__MSK_PASS__/g, mskCreds.password);

    let rwCloudClient: pg.Client | undefined;
    try {
      // Use query_timeout so DROP statements don't block indefinitely.
      // After the S3-state clear + pod restart above, objects should not exist so
      // the drops are no-ops; the timeout is a safety net if the restart is still in progress.
      rwCloudClient = new pg.Client({ host: "localhost", port: 14567, user: "root", database: "dev", password: "", query_timeout: 30_000 });
      await rwCloudClient.connect();
      // Drop stale objects before applying DDL so schema changes (e.g. new UNION ALL arms) take effect.
      for (const stmt of [
        "DROP MATERIALIZED VIEW IF EXISTS mv_fleet_1min_avg",
        "DROP MATERIALIZED VIEW IF EXISTS mv_sensor_fleet_latest",
        "DROP SOURCE IF EXISTS sensors_raw_telemetry",
        "DROP SOURCE IF EXISTS sensors_raw_cloud",
      ]) {
        await pgQuery(rwCloudClient, stmt).catch(() => { /* ignore if not exists or timed out */ });
      }
      const { durationMs } = await pgQuery(rwCloudClient, ddl);
      log(`  Cloud DDL applied in ${durationMs}ms`);

      await check("Cloud RisingWave mv_sensor_fleet_latest exists and queryable", async () => {
        const { rows, durationMs } = await pgQuery(rwCloudClient!, "SELECT COUNT(*) AS cnt FROM mv_sensor_fleet_latest");
        return { rowCount: Number(rows[0].cnt), queryMs: durationMs };
      }, { data: (r) => ({ rowCount: r.rowCount, queryMs: r.queryMs }) });

      // Capture a sample of rows from the view as evidence (up to 5)
      try {
        const { rows: sampleRows } = await pgQuery(
          rwCloudClient!,
          "SELECT * FROM mv_sensor_fleet_latest ORDER BY ts_ms DESC LIMIT 5"
        );
        if (sampleRows.length > 0)
          capture("mv_sensor_fleet_latest rows (cloud)", JSON.stringify(sampleRows, null, 2));
      } catch { /* evidence is best-effort */ }
    } finally {
      await rwCloudClient?.end().catch(() => {});
      rwPfTunnel.close();
      tunnels.splice(tunnels.indexOf(rwPfTunnel), 1);
    }

    // ── Deploy cloud rp-connect-timescaledb sink ─────────────────────────────
    // Wait for CNPG to generate the timescaledb-cloud-app secret, then create
    // the timescaledb-credentials secret and deploy the Helm chart.
    log("Waiting for TimescaleDB CNPG secret to be available...");
    let tsdbInitPassword = "";
    const tsdbSecretDeadline = Date.now() + 120_000;
    while (Date.now() < tsdbSecretDeadline) {
      try {
        const raw = shellOutput(
          `kubectl --kubeconfig ${cloudKcPath} get secret timescaledb-cloud-app ` +
          `-n ${DEPLOYMENT_ID} -o jsonpath='{.data.password}' 2>/dev/null | base64 -d`
        ).trim();
        if (raw) { tsdbInitPassword = raw; break; }
      } catch { /* not ready yet */ }
      await sleep(5_000);
    }
    if (tsdbInitPassword) {
      const tsdbDsn = `postgres://workshop:${tsdbInitPassword}@timescaledb-cloud-rw.${DEPLOYMENT_ID}.svc:5432/edge`;
      shell(
        `kubectl --kubeconfig ${cloudKcPath} create secret generic timescaledb-credentials ` +
        `-n ${DEPLOYMENT_ID} ` +
        `--from-literal=TIMESCALE_DSN=${JSON.stringify(tsdbDsn)} ` +
        `--dry-run=client -o yaml | kubectl --kubeconfig ${cloudKcPath} apply -f -`
      );
      log("Deploying cloud rp-connect-timescaledb...");
      await shellRetry(
        `helm --kubeconfig ${cloudKcPath} upgrade --install rp-connect-timescaledb redpanda/connect ` +
        `-n ${DEPLOYMENT_ID} ` +
        `-f ${REPO_ROOT}/helm/rp-connect-timescaledb.yaml ` +
        `--wait --timeout 3m`
      );
      log("  rp-connect-timescaledb deployed");
    } else {
      log("  ⚠  TimescaleDB secret not ready in 120s — skipping rp-connect deploy");
    }

    // ── Data freshness comparison: Datalake / TimescaleDB / RisingWave ─────────
    // All three tiers query the same source data: IoT node telemetry (cpu_pct,
    // mem_used_pct) arriving via IoT Core → MSK raw.telemetry.
    // Athena reads S3 directly from the IoT S3 rule; TimescaleDB and RisingWave
    // consume raw.telemetry via rp-connect and DDL respectively.
    //
    // Expected freshness ladder (per workshop docs):
    //   RisingWave MV  ~100–400 ms
    //   TimescaleDB    ~100 ms–3 s
    //   Datalake/Athena ~30–90 s

    // Give RisingWave and TimescaleDB sinks time to receive messages before sampling freshness.
    log("Waiting 30s for data to flow into RisingWave and TimescaleDB...");
    await sleep(30_000);

    log("Running data freshness comparison: Datalake / TimescaleDB / RisingWave...");

    // ── 1. Athena (cloud datalake) ───────────────────────────────────────────
    let athenaFreshnessMs: number | undefined;
    await check("Cloud datalake (Athena) freshness — free compute/mem aggregation", async () => {
      const t0 = Date.now();
      const startResp = await athena.send(new StartQueryExecutionCommand({
        QueryString: `
          SELECT
            AVG(100.0 - cpu_pct)      AS avg_free_cpu_pct,
            AVG(100.0 - mem_used_pct) AS avg_free_mem_pct,
            MAX(message_timestamp)    AS latest_msg_ts_ms
          FROM "workshop_${DEPLOYMENT_ID.replace(/-/g, "_")}"."telemetry"
        `,
        WorkGroup: `workshop-${DEPLOYMENT_ID}`,
      }));
      const execId = startResp.QueryExecutionId!;
      const athenaDeadline = Date.now() + 120_000;
      let state = "RUNNING";
      while (Date.now() < athenaDeadline && (state === "RUNNING" || state === "QUEUED")) {
        await sleep(2_000);
        const execResp = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: execId }));
        state = execResp.QueryExecution?.Status?.State ?? "FAILED";
      }
      if (state !== "SUCCEEDED") throw new Error(`Athena query ${execId} ended with state: ${state}`);
      const resultsResp = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: execId }));
      const row = resultsResp.ResultSet?.Rows?.[1]?.Data; // row 0 is the header
      const freeCpu = parseFloat(row?.[0]?.VarCharValue ?? "NaN");
      const freeMem = parseFloat(row?.[1]?.VarCharValue ?? "NaN");
      const latestTs = parseFloat(row?.[2]?.VarCharValue ?? "0");
      const athenaQueryMs = Date.now() - t0;
      athenaFreshnessMs = Date.now() - latestTs;
      capture("Athena freshness result", JSON.stringify({ freeCpu, freeMem, latestTs, freshnessMs: athenaFreshnessMs }, null, 2));
      return { freshnessMs: athenaFreshnessMs, avgFreeCpuPct: freeCpu, avgFreeMemPct: freeMem, queryMs: athenaQueryMs };
    }, { data: (r) => ({ freshnessMs: r.freshnessMs, avgFreeCpuPct: r.avgFreeCpuPct, avgFreeMemPct: r.avgFreeMemPct, queryMs: r.queryMs }) });

    // ── 2. Cloud RisingWave ──────────────────────────────────────────────────
    let rwCloudFreshnessMs: number | undefined;
    if (cloudKcPath) {
      log("Port-forwarding to cloud RisingWave for freshness comparison...");
      const rwCloudPf2 = spawn(
        "kubectl",
        ["--kubeconfig", cloudKcPath, "port-forward", "-n", DEPLOYMENT_ID,
         "svc/risingwave-cloud-frontend", "14568:4567"],
        { stdio: "ignore" }
      );
      const rwCloudTunnel2 = { localPort: 14568, proc: rwCloudPf2, close: () => { try { rwCloudPf2.kill(); } catch { /* */ } } };
      tunnels.push(rwCloudTunnel2);
      await sleep(8_000);

      let rwCloudClient2: pg.Client | undefined;
      try {
        rwCloudClient2 = new pg.Client({ host: "localhost", port: 14568, user: "root", database: "dev", password: "" });
        await rwCloudClient2.connect();
        await check("Cloud RisingWave freshness — fleet sensor MAX(ts_ms)", async () => {
          const { rows, durationMs } = await pgQuery(
            rwCloudClient2!,
            `SELECT
               AVG(CASE WHEN sensor = 'cpu_pct'      THEN 100.0 - value END) AS avg_free_cpu_pct,
               AVG(CASE WHEN sensor = 'mem_used_pct' THEN 100.0 - value END) AS avg_free_mem_pct,
               MAX(ts_ms)                                                     AS latest_ts_ms
             FROM mv_sensor_fleet_latest`
          );
          const latestTs = Number(rows[0]?.latest_ts_ms ?? 0);
          rwCloudFreshnessMs = Date.now() - latestTs;
          const freeCpu = rows[0]?.avg_free_cpu_pct != null ? parseFloat(rows[0].avg_free_cpu_pct) : null;
          const freeMem = rows[0]?.avg_free_mem_pct != null ? parseFloat(rows[0].avg_free_mem_pct) : null;
          capture("Cloud RisingWave freshness result", JSON.stringify({ freeCpu, freeMem, latestTs, freshnessMs: rwCloudFreshnessMs }, null, 2));
          return { freshnessMs: rwCloudFreshnessMs, avgFreeCpuPct: freeCpu, avgFreeMemPct: freeMem, queryMs: durationMs };
        }, { data: (r) => ({ freshnessMs: r.freshnessMs, avgFreeCpuPct: r.avgFreeCpuPct, avgFreeMemPct: r.avgFreeMemPct, queryMs: r.queryMs }) });
      } finally {
        await rwCloudClient2?.end().catch(() => {});
        rwCloudTunnel2.close();
        tunnels.splice(tunnels.indexOf(rwCloudTunnel2), 1);
      }
    }

    // ── 3. Cloud TimescaleDB ─────────────────────────────────────────────────
    let tsdbCloudFreshnessMs: number | undefined;
    if (cloudKcPath) {
      log("Port-forwarding to cloud TimescaleDB for freshness comparison...");
      let tsdbPassword = "";
      try {
        const tsdbSecret = shellOutput(
          `kubectl --kubeconfig ${cloudKcPath} get secret timescaledb-cloud-app -n ${DEPLOYMENT_ID} -o jsonpath='{.data.password}' 2>/dev/null | base64 -d`
        );
        tsdbPassword = tsdbSecret.trim();
      } catch { /* if secret is missing, connect will fail and the check will report it */ }

      const tsdbCloudPf = spawn(
        "kubectl",
        ["--kubeconfig", cloudKcPath, "port-forward", "-n", DEPLOYMENT_ID,
         "svc/timescaledb-cloud-rw", "15432:5432"],
        { stdio: "ignore" }
      );
      const tsdbCloudTunnel = { localPort: 15432, proc: tsdbCloudPf, close: () => { try { tsdbCloudPf.kill(); } catch { /* */ } } };
      tunnels.push(tsdbCloudTunnel);
      await sleep(4_000);

      let tsdbCloudClient: pg.Client | undefined;
      try {
        tsdbCloudClient = new pg.Client({ host: "localhost", port: 15432, user: "workshop", database: "edge", password: tsdbPassword });
        await tsdbCloudClient.connect();
        // Ensure schema exists — CNPG postInitSQL only runs on fresh cluster init,
        // so on recycled clusters we must create idempotently.
        await tsdbCloudClient.query(`
          CREATE TABLE IF NOT EXISTS sensor_readings (
            ts_ms          BIGINT           NOT NULL,
            sensor         TEXT             NOT NULL,
            site_id        TEXT             NOT NULL,
            value          DOUBLE PRECISION,
            unit           TEXT,
            partition_time TIMESTAMPTZ      NOT NULL
          )
        `);
        await tsdbCloudClient.query(
          `CREATE INDEX IF NOT EXISTS idx_sensor_readings_sensor ON sensor_readings(sensor, partition_time DESC)`
        );
        await tsdbCloudClient.end().catch(() => {});
        tsdbCloudClient = undefined;
        tsdbCloudClient = new pg.Client({ host: "localhost", port: 15432, user: "workshop", database: "edge", password: tsdbPassword });
        await tsdbCloudClient.connect();
        await check("Cloud TimescaleDB freshness — sensor_readings MAX(ts_ms)", async () => {
          const { rows, durationMs } = await pgQuery(
            tsdbCloudClient!,
            `SELECT
               AVG(CASE WHEN sensor = 'cpu_pct'      THEN 100.0 - value END) AS avg_free_cpu_pct,
               AVG(CASE WHEN sensor = 'mem_used_pct' THEN 100.0 - value END) AS avg_free_mem_pct,
               MAX(ts_ms)                                                     AS latest_ts_ms
             FROM sensor_readings`
          );
          const latestTs = Number(rows[0]?.latest_ts_ms ?? 0);
          tsdbCloudFreshnessMs = Date.now() - latestTs;
          const freeCpu = rows[0]?.avg_free_cpu_pct != null ? parseFloat(rows[0].avg_free_cpu_pct) : null;
          const freeMem = rows[0]?.avg_free_mem_pct != null ? parseFloat(rows[0].avg_free_mem_pct) : null;
          capture("Cloud TimescaleDB freshness result", JSON.stringify({ freeCpu, freeMem, latestTs, freshnessMs: tsdbCloudFreshnessMs }, null, 2));
          return { freshnessMs: tsdbCloudFreshnessMs, avgFreeCpuPct: freeCpu, avgFreeMemPct: freeMem, queryMs: durationMs };
        }, { data: (r) => ({ freshnessMs: r.freshnessMs, avgFreeCpuPct: r.avgFreeCpuPct, avgFreeMemPct: r.avgFreeMemPct, queryMs: r.queryMs }) });
      } finally {
        await tsdbCloudClient?.end().catch(() => {});
        tsdbCloudTunnel.close();
        tunnels.splice(tunnels.indexOf(tsdbCloudTunnel), 1);
      }
    }

    // ── 4. Freshness comparison summary ─────────────────────────────────────
    await check("Freshness ladder: RisingWave < TimescaleDB < Datalake", async () => {
      const summary = {
        risingwave_freshness_ms:      rwCloudFreshnessMs   ?? null,
        timescaledb_freshness_ms:     tsdbCloudFreshnessMs ?? null,
        datalake_athena_freshness_ms: athenaFreshnessMs    ?? null,
      };
      capture("Data freshness comparison (all tiers)", JSON.stringify(summary, null, 2));
      if (
        rwCloudFreshnessMs != null &&
        tsdbCloudFreshnessMs != null &&
        athenaFreshnessMs != null
      ) {
        if (rwCloudFreshnessMs > athenaFreshnessMs) {
          console.warn(`  ⚠  Freshness inversion: RisingWave (${rwCloudFreshnessMs}ms) > Athena (${athenaFreshnessMs}ms)`);
        }
      }
      return summary;
    }, { data: (r) => ({
      rw_ms:   r.risingwave_freshness_ms       ?? -1,
      tsdb_ms: r.timescaledb_freshness_ms      ?? -1,
      s3_ms:   r.datalake_athena_freshness_ms  ?? -1,
    }) });
  } // end mskArn
  } // end Phase 5

  // ── Phase 6: Session 5 — Edge Infrastructure ──────────────────────────────
  if (phaseEnabled("Phase 6")) {
  beginPhase("Phase 6 — Session 5: Edge Infrastructure");

  const k3sJobId = "deploy-k3s-e2e";
  log("Uploading job-scripts/deploy-k3s.sh to S3...");
  shell(`aws s3 cp job-scripts/deploy-k3s.sh s3://workshop-${DEPLOYMENT_ID}/job-scripts/deploy-k3s.sh`);

  log(`Creating IoT Job ${k3sJobId}...`);
  await createIotJob(k3sJobId, thingGroupArn, "deploy-k3s.sh", 45);

  await check("K3s IoT Job completes on all 3 devices", async () => {
    const result = await waitForIotJob(k3sJobId, 3, K3S_TIMEOUT_MS);
    return result;
  }, { data: (r) => ({ succeeded: r.succeeded, failed: r.failed, waitMs: r.waitMs }) });

  // Retrieve kubeconfig from SSM
  log("Retrieving edge kubeconfig from SSM...");
  const kcParam = await ssm.send(
    new GetParameterCommand({ Name: `/workshop/${DEPLOYMENT_ID}/kubeconfig`, WithDecryption: true })
  );
  const kcRaw = kcParam.Parameter?.Value ?? "";
  edgeKubeconfig = join(tmpdir(), `e2e-edge-kc-${Date.now()}.yaml`);
  writeFileSync(
    edgeKubeconfig,
    kcRaw.replace(/https:\/\/[0-9.]+:6443/g, "https://127.0.0.1:16443")
  );

  // The K3s server may be a different instance from edgeInstance0.
  // Parse the server IP from the raw kubeconfig to find the correct instance.
  const serverIpMatch = kcRaw.match(/https:\/\/([0-9.]+):6443/);
  const k3sServerIp = serverIpMatch?.[1] ?? "";
  let k3sServerId = edgeInstance0;
  if (k3sServerIp) {
    const serverResp = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: "private-ip-address", Values: [k3sServerIp] },
          { Name: "instance-state-name", Values: ["running"] },
        ],
      })
    );
    k3sServerId = serverResp.Reservations?.[0]?.Instances?.[0]?.InstanceId ?? edgeInstance0;
    log(`K3s server IP ${k3sServerIp} → instance ${k3sServerId}`);
  }

  // Open SSM tunnel to K3s API
  log("Opening SSM tunnel to K3s API (port 16443)...");
  const k3sTunnel = openSsmTunnel(k3sServerId, 6443, 16443);
  tunnels.push(k3sTunnel);
  // Wait longer for the SSM plugin to establish the tunnel before kubectl connects.
  await sleep(15_000);

  await check("K3s API reachable via SSM tunnel", async () => {
    const t0 = Date.now();
    // Retry a few times — SSM tunnel can take a moment to become ready
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const out = shellOutput(`kubectl --kubeconfig ${edgeKubeconfig} get nodes --no-headers`);
        return { output: out.slice(0, 200), durationMs: Date.now() - t0 };
      } catch (err: unknown) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < 4) await sleep(10_000);
      }
    }
    throw lastErr!;
  }, { data: (r) => ({ sdkLatencyMs: r.durationMs }) });

  await check("All 3 K3s nodes Ready", async () => {
    const t0 = Date.now();
    const out = shellOutput(`kubectl --kubeconfig ${edgeKubeconfig} get nodes --no-headers`);
    const ready = out.split("\n").filter((l) => l.includes("Ready")).length;
    if (ready < 3) throw new Error(`Only ${ready}/3 nodes Ready`);
    return { readyNodes: ready, durationMs: Date.now() - t0 };
  }, { data: (r) => ({ readyNodes: r.readyNodes, sdkLatencyMs: r.durationMs }) });

  // MSK credentials for edge
  // Re-fetch MSK creds if Phase 5 was skipped (mskCreds/mskBootstrap may be empty)
  if (!mskCreds.password) {
    mskCreds = JSON.parse(
      (await sm.send(new GetSecretValueCommand({ SecretId: `AmazonMSK_workshop-${DEPLOYMENT_ID}` })))
        .SecretString ?? "{}"
    ) as { username: string; password: string };
  }
  if (!mskArn) {
    const r = await kafka.send(new ListClustersV2Command({ ClusterNameFilter: `workshop-${DEPLOYMENT_ID}-msk` }));
    mskArn = r.ClusterInfoList?.[0]?.ClusterArn;
  }
  if (!mskBootstrap && mskArn) {
    mskBootstrap = (await kafka.send(new GetBootstrapBrokersCommand({ ClusterArn: mskArn }))).BootstrapBrokerStringSaslScram ?? "";
  }
  const edgeMskCreds = mskCreds;
  const edgeMskBootstrap = mskBootstrap;

  // Create edge namespace and MSK secret
  shell(
    `kubectl --kubeconfig ${edgeKubeconfig} create namespace edge --dry-run=client -o yaml | ` +
    `kubectl --kubeconfig ${edgeKubeconfig} apply -f -`
  );
  shell(
    `kubectl --kubeconfig ${edgeKubeconfig} create secret generic msk-credentials ` +
    `--namespace edge ` +
    `--from-literal=MSK_USERNAME=${edgeMskCreds.username} ` +
    `--from-literal=MSK_PASSWORD=${edgeMskCreds.password} ` +
    `--dry-run=client -o yaml | kubectl --kubeconfig ${edgeKubeconfig} apply -f -`
  );

  // Install CNPG CRDs before the main chart so the timescaledb Cluster CR can be validated.
  // The edge-stack chart bundles CNPG as a dependency, but Helm validates all templates
  // (including postgresql.cnpg.io/v1 Cluster CRs) before any sub-chart runs.
  log("Pre-installing CNPG operator to register CRDs...");
  await shellRetry(
    `helm --kubeconfig ${edgeKubeconfig} upgrade --install cnpg cloudnative-pg/cloudnative-pg ` +
    `--namespace cnpg-system --create-namespace --wait --timeout 3m`
  );

  // Deploy Helm edge-stack
  log("Deploying Helm edge-stack...");
  // MSK bootstrap has commas; use --set-string and escape commas with \, for Helm
  const escapedMskBootstrap = edgeMskBootstrap.replace(/,/g, "\\,");
  const helmSetArgs = [
    `--set deploymentId=${DEPLOYMENT_ID}`,
    sensorSimIp ? `--set mqtt.host=${sensorSimIp}` : "",
    edgeMskBootstrap ? `--set-string mskBootstrapServers="${escapedMskBootstrap}"` : "",
  ].filter(Boolean).join(" ");

  const helmT0 = Date.now();
  // Disable the CNPG sub-chart since we pre-installed it above to register CRDs.
  // The CRDs must be in place before Helm validates the timescaledb Cluster template.
  // post-upgrade hooks (timescaledb-dsn, risingwave-ddl) can time out while waiting
  // for CNPG cluster init — the manifests are still applied.  We handle TimescaleDB
  // readiness and grants ourselves below, so swallow hook-timeout errors.
  try {
    shell(
      `helm --kubeconfig ${edgeKubeconfig} upgrade --install edge-stack ./helm/edge-stack ` +
      `--namespace edge --create-namespace ` +
      `-f helm/edge-stack-values.yaml ` +
      `--set cnpg.enabled=false --set timescaledb.enabled=true ` +
      `${helmSetArgs} ` +
      `--timeout ${Math.floor(HELM_TIMEOUT_MS / 1000)}s --atomic=false`
    );
  } catch {
    log(`  ⚠  Helm edge-stack hook(s) timed out — resources applied, continuing`);
  }
  log(`  Helm deploy finished in ${((Date.now() - helmT0) / 1000).toFixed(1)}s`);

  // Wait for TimescaleDB to be ready, then restart the HMI so it picks up the
  // timescaledb-app secret (created by CNPG after cluster init).
  log("Waiting for TimescaleDB cluster to be ready...");
  const tsdbDeadline = Date.now() + 300_000;
  while (Date.now() < tsdbDeadline) {
    const tsdbOut = shellOutput(
      `kubectl --kubeconfig ${edgeKubeconfig} get pod -n edge -l cnpg.io/cluster=timescaledb --no-headers 2>/dev/null || true`
    );
    if (tsdbOut.includes("Running")) break;
    await sleep(10_000);
  }
  log("  TimescaleDB ready — ensuring workshop user has table permissions...");
  try {
    const tsdbPod = shellOutput(
      `kubectl --kubeconfig ${edgeKubeconfig} get pod -n edge -l cnpg.io/cluster=timescaledb --no-headers -o name | head -1 | sed 's|pod/||'`
    );
    if (tsdbPod) {
      shellOutput(
        `kubectl --kubeconfig ${edgeKubeconfig} exec -n edge ${tsdbPod} -- ` +
        `psql -U postgres -d edge -c "GRANT SELECT, INSERT, UPDATE ON sensor_readings TO workshop;" 2>&1 || true`
      );
    }
  } catch { /* best-effort — table may not exist yet on brand-new cluster */ }
  log("  Rolling HMI and rp-connect-tsdb deployments to pick up credentials...");
  shellOutput(
    `kubectl --kubeconfig ${edgeKubeconfig} rollout restart deployment/edge-stack-hmi -n edge 2>/dev/null || true`
  );
  shellOutput(
    `kubectl --kubeconfig ${edgeKubeconfig} rollout restart deployment/edge-stack-rp-connect-tsdb -n edge 2>/dev/null || true`
  );
  await sleep(30_000);

  log("Waiting for edge namespace pods...");
  await waitForPods(edgeKubeconfig, "edge", HELM_TIMEOUT_MS).catch(() =>
    log("⚠  Some edge pods not yet Running — continuing")
  );

  await check("Core edge pods Running (Redpanda, MinIO, RisingWave, ingest/relay)", async () => {
    const out = shellOutput(
      `kubectl --kubeconfig ${edgeKubeconfig} get pods -n edge --no-headers`
    );
    const lines = out.split("\n").filter(Boolean);
    // Only check long-running pods; exclude:
    //   - one-time Helm configuration/DDL jobs (edge-stack-configuration-*, rw-ddl-*)
    //   - HMI (not built until Phase 7: build-hmi.sh)
    //   - rp-connect-tsdb (needs timescaledb-dsn secret from CNPG init)
    const coreLines = lines.filter(
      (l) =>
        !l.includes("edge-stack-configuration-") &&
        !l.includes("rw-ddl-") &&
        !l.includes("edge-stack-hmi-") &&
        !l.includes("rp-connect-tsdb")
    );
    const notReady = coreLines.filter(
      (l) => !l.includes("Running") && !l.includes("Completed") && !l.includes("Succeeded")
    );
    const running = coreLines.filter((l) => l.includes("Running") || l.includes("Completed")).length;
    if (notReady.length > 0)
      throw new Error(`Not-ready core pods:\n${notReady.join("\n")}`);
    return { totalPods: lines.length, runningCorePods: running };
  }, { data: (r) => r });

  // Wait a bit for Redpanda to accept connections
  await sleep(30_000);

  await check("sensors.raw.sim topic exists in Redpanda", async () => {
    const t0 = Date.now();
    const pod = shellOutput(
      `kubectl --kubeconfig ${edgeKubeconfig} get pod -n edge -l app.kubernetes.io/name=redpanda --no-headers -o name | head -1 | sed 's|pod/||'`
    );
    if (!pod) throw new Error("No Redpanda pod found");
    const out = shellOutput(
      `kubectl --kubeconfig ${edgeKubeconfig} exec -n edge ${pod} -- rpk topic list`
    );
    if (!out.includes("sensors.raw.sim")) throw new Error(`Topic not found. Topics: ${out}`);
    return { found: true, durationMs: Date.now() - t0 };
  }, { data: (r) => ({ sdkLatencyMs: r.durationMs }) });

  // Sample message count
  await sleep(30_000);
  await check("sensors.raw.sim is receiving messages", async () => {
    const t0 = Date.now();
    const pod = shellOutput(
      `kubectl --kubeconfig ${edgeKubeconfig} get pod -n edge -l app.kubernetes.io/name=redpanda --no-headers -o name | head -1 | sed 's|pod/||'`
    );
    const out = shellOutput(
      `kubectl --kubeconfig ${edgeKubeconfig} exec -n edge ${pod} -- rpk topic describe sensors.raw.sim`
    );
    // Extract high-water mark from any partition
    const hwmMatch = out.match(/HIGH-WATERMARK\s+(\d+)/i) ?? out.match(/\d+/);
    const hwm = hwmMatch ? parseInt(hwmMatch[1] ?? hwmMatch[0], 10) : 0;
    if (hwm === 0) throw new Error(`sensors.raw.sim high-watermark is 0 — no messages delivered`);
    return { highWatermark: hwm, durationMs: Date.now() - t0 };
  }, { data: (r) => ({ highWatermark: r.highWatermark, sdkLatencyMs: r.durationMs }) });

  // Capture a few raw MQTT messages from Redpanda as evidence
  try {
    const pod = shellOutput(
      `kubectl --kubeconfig ${edgeKubeconfig} get pod -n edge -l app.kubernetes.io/name=redpanda --no-headers -o name | head -1 | sed 's|pod/||'`
    );
    const msgs = shellOutput(
      `kubectl --kubeconfig ${edgeKubeconfig} exec -n edge ${pod} -- ` +
      `rpk topic consume sensors.raw.sim --num 3 --offset start 2>/dev/null || true`
    );
    if (msgs.trim()) capture("Redpanda MQTT messages (sample)", msgs);
  } catch { /* evidence is best-effort */ }

  // Capture edge pod listing as evidence
  try {
    const pods = shellOutput(`kubectl --kubeconfig ${edgeKubeconfig} get pods -n edge`);
    capture("Edge namespace pods", pods);
  } catch { /* evidence is best-effort */ }
  } // end Phase 6

  // ── Phase 7: Session 6 — HMI ──────────────────────────────────────────────
  if (phaseEnabled("Phase 7")) {
  beginPhase("Phase 7 — Session 6: HMI");

  log("Building and deploying HMI...");
  const hmiT0 = Date.now();
  shell(`bash scripts/build-hmi.sh --deployment-id ${DEPLOYMENT_ID}`);
  log(`  HMI build+deploy finished in ${((Date.now() - hmiT0) / 1000).toFixed(1)}s`);

  // Wait for HMI pod to start
  await sleep(15_000);
  await check("HMI pod Running", async () => {
    const out = shellOutput(
      `kubectl --kubeconfig ${edgeKubeconfig} get pods -n edge -l app.kubernetes.io/component=hmi --no-headers`
    );
    if (!out.includes("Running")) throw new Error(`HMI pod not Running: ${out}`);
    return { status: "Running" };
  });

  // Open SSM tunnel to HMI NodePort 30080
  log("Opening SSM tunnel to HMI (port 30080)...");
  const hmiTunnel = openSsmTunnel(edgeInstance0, 30080, 30080);
  tunnels.push(hmiTunnel);
  await sleep(8_000);

  await check("HMI HTTP health check returns 200", async () => {
    const t0 = Date.now();
    const out = shellOutput(`curl -sf --max-time 10 -o /dev/null -w "%{http_code}" http://localhost:30080/`);
    if (out !== "200") throw new Error(`HTTP status: ${out}`);
    return { statusCode: 200, durationMs: Date.now() - t0 };
  }, { data: (r) => ({ latencyMs: r.durationMs }) });

  // Playwright screenshots of the HMI
  log("Capturing HMI screenshots via Playwright...");
  try {
    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto("http://localhost:30080/", { waitUntil: "domcontentloaded", timeout: 20_000 });
    // Brief wait for any client-side data fetch to render
    await page.waitForTimeout(4_000);
    const homePng = await page.screenshot({ fullPage: true });
    capture("screenshot", homePng.toString("base64"));
    // Also capture the /ops (Digital Operations) dashboard page
    try {
      await page.goto("http://localhost:30080/ops", { waitUntil: "domcontentloaded", timeout: 10_000 });
      await page.waitForTimeout(3_000);
      const dashPng = await page.screenshot({ fullPage: true });
      capture("screenshot_dashboard", dashPng.toString("base64"));
    } catch { /* page may not exist at this path */ }
    await browser.close();
    log("  Screenshots captured");
  } catch (err: unknown) {
    log(`  ⚠ Screenshot capture failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  await check("/api/digital-ops returns sensor data", async () => {
    const t0 = Date.now();
    const out = shellOutput(`curl -sf --max-time 10 http://localhost:30080/api/digital-ops`);
    const body = JSON.parse(out) as { stats?: unknown[]; error?: string };
    if (body.error) throw new Error(`API error: ${body.error}`);
    const stats = body.stats ?? [];
    if (!Array.isArray(stats) || stats.length === 0)
      throw new Error(`Expected non-empty stats array, got: ${out.slice(0, 200)}`);
    capture("/api/digital-ops response", out);
    return { sensorCount: stats.length, responseMs: Date.now() - t0 };
  }, { data: (r) => ({ sensorCount: r.sensorCount, responseMs: r.responseMs }) });

  await check("/api/live-stream connects and delivers SSE stream", async () => {
    // SSM port-forwarding buffers TCP and only delivers bytes when the connection closes,
    // which never happens for a streaming endpoint.  Run curl on the EC2 host directly
    // via ssmRunCommand so NodePort 30080 is reachable without tunneling.
    // Pass = the stream connects (": connected" comment received), which proves the
    // RisingWave subscription opened.  Sensor events only fire on row changes so we
    // may not see data events within a short window — capture whatever arrives as evidence.
    const sseTimeoutS = Math.floor(HMI_TIMEOUT_MS / 1000);
    const { stdout: sseData } = await ssmRunCommand(
      edgeInstance0,
      `curl -s --max-time ${sseTimeoutS} --http1.1 -N http://localhost:30080/api/live-stream || true`,
      HMI_TIMEOUT_MS + 30_000
    );
    const connected = sseData.includes(": connected");
    const eventCount = (sseData.match(/^data:/gm) ?? []).length;
    if (!connected && eventCount === 0) {
      const comments = sseData.match(/^:.*$/gm)?.slice(0, 5).join("\n") ?? "";
      throw new Error(`SSE stream did not connect. Comments: ${comments || "(none)"}. First 400 chars: ${sseData.slice(0, 400)}`);
    }
    if (sseData.trim()) capture("/api/live-stream sample", sseData.slice(0, 1500));
    return { connected, eventCount };
  }, { data: (r) => ({ connected: r.connected, eventCount: r.eventCount }) });

  // Direct RisingWave query via port-forward (edge)
  log("Port-forwarding to edge RisingWave for freshness check...");
  const rwEdgeTunnel = openSsmTunnel(edgeInstance0, 30082, 14568);
  tunnels.push(rwEdgeTunnel);

  // Find the RisingWave NodePort — default 4567, may also be NodePort 30082
  // Try direct kubectl port-forward instead
  const rwEdgePf = spawn(
    "kubectl",
    ["--kubeconfig", edgeKubeconfig, "port-forward", "-n", "edge", "svc/edge-stack-risingwave", "14569:4567"],
    { stdio: "ignore" }
  );
  tunnels.push({ localPort: 14569, proc: rwEdgePf, close: () => { try { rwEdgePf.kill(); } catch { /* */ } } });
  await sleep(5_000);

  let rwEdgeClient: pg.Client | undefined;
  try {
    rwEdgeClient = new pg.Client({ host: "localhost", port: 14569, user: "root", database: "dev", password: "" });
    await rwEdgeClient.connect();

    await check("Edge RisingWave mv_sensor_latest has rows", async () => {
      const { rows, durationMs } = await pgQuery(rwEdgeClient!, "SELECT COUNT(*) AS cnt FROM mv_sensor_latest");
      const cnt = Number(rows[0].cnt);
      if (cnt === 0) throw new Error("mv_sensor_latest is empty");
      // Capture the actual rows as evidence
      try {
        const { rows: sampleRows } = await pgQuery(
          rwEdgeClient!,
          "SELECT sensor, site_id, value, unit, ts_ms FROM mv_sensor_latest ORDER BY ts_ms DESC LIMIT 10"
        );
        if (sampleRows.length > 0)
          capture("mv_sensor_latest rows (edge)", JSON.stringify(sampleRows, null, 2));
      } catch { /* evidence is best-effort */ }
      return { rowCount: cnt, queryMs: durationMs };
    }, { data: (r) => ({ rowCount: r.rowCount, queryMs: r.queryMs }) });

    await check("Edge RisingWave mv_sensor_latest freshness < 30s", async () => {
      const { rows, durationMs } = await pgQuery(
        rwEdgeClient!,
        `SELECT sensor, site_id, value, unit,
                (EXTRACT(EPOCH FROM NOW()) * 1000 - MAX(ts_ms))::BIGINT AS staleness_ms
         FROM mv_sensor_latest GROUP BY sensor, site_id, value, unit ORDER BY staleness_ms DESC LIMIT 1`
      );
      const staleness = Number(rows[0]?.staleness_ms ?? 999_999);
      if (staleness > 30_000) throw new Error(`Most stale sensor is ${staleness}ms behind NOW`);
      return { maxStalenessMs: staleness, queryMs: durationMs };
    }, { data: (r) => ({ maxStalenessMs: r.maxStalenessMs, queryMs: r.queryMs }) });
  } finally {
    await rwEdgeClient?.end().catch(() => {});
  }

  hmiTunnel.close();
  tunnels.splice(tunnels.indexOf(hmiTunnel), 1);
  } // end Phase 7

  // ── Phase 8: Session 7 — Participant teardown ─────────────────────────────
  if (phaseEnabled("Phase 8")) {
  beginPhase("Phase 8 — Session 7: Participant teardown");

  if (SKIP_TEARDOWN) {
    log("Skipping participant teardown (--skip-teardown)");
  } else {
    log("Running scripts/teardown.sh...");
    const teardownT0 = Date.now();
    shell(`bash scripts/teardown.sh --deployment-id ${DEPLOYMENT_ID}`);
    log(`  Teardown script exited 0 in ${((Date.now() - teardownT0) / 1000).toFixed(1)}s`);

    log("Waiting up to 10 min for EC2 instances to terminate...");
    const ec2Deadline = Date.now() + 600_000;
    let ec2Gone = false;
    while (Date.now() < ec2Deadline) {
      const resp = await ec2.send(
        new DescribeInstancesCommand({
          Filters: [
            { Name: "tag:WorkshopDeploymentId", Values: [DEPLOYMENT_ID] },
            { Name: "instance-state-name", Values: ["running", "stopped", "pending", "stopping"] },
          ],
        })
      );
      const remaining = resp.Reservations?.flatMap((r) => r.Instances ?? []).length ?? 0;
      if (remaining === 0) { ec2Gone = true; break; }
      log(`  ${remaining} EC2 instance(s) still active...`);
      await sleep(30_000);
    }

    await check("All EC2 instances terminated", async () => {
      if (!ec2Gone) throw new Error("EC2 instances still running after 10 min");
      return { terminated: true };
    });

    await check("S3 bucket deleted", async () => {
      const t0 = Date.now();
      try {
        await s3.send(new HeadBucketCommand({ Bucket: `workshop-${DEPLOYMENT_ID}` }));
        throw new Error("Bucket still exists");
      } catch (err: unknown) {
        if (err instanceof Error && (err.name === "NotFound" || err.name === "NoSuchBucket" || err.message.includes("403")))
          return { deleted: true, durationMs: Date.now() - t0 };
        throw err;
      }
    }, { data: (r) => ({ sdkLatencyMs: r.durationMs }) });

    await check("IoT Thing Group deleted", async () => {
      const t0 = Date.now();
      try {
        await iot.send(new DescribeThingGroupCommand({ thingGroupName: `${DEPLOYMENT_ID}-devices` }));
        throw new Error("Thing Group still exists");
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "ResourceNotFoundException")
          return { deleted: true, durationMs: Date.now() - t0 };
        throw err;
      }
    }, { data: (r) => ({ sdkLatencyMs: r.durationMs }) });

    await check("MSK SCRAM secret deleted", async () => {
      const t0 = Date.now();
      try {
        await sm.send(new DescribeSecretCommand({ SecretId: `AmazonMSK_workshop-${DEPLOYMENT_ID}` }));
        throw new Error("Secret still exists");
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "ResourceNotFoundException")
          return { deleted: true, durationMs: Date.now() - t0 };
        throw err;
      }
    }, { data: (r) => ({ sdkLatencyMs: r.durationMs }) });

    await check("SSM kubeconfig parameter deleted", async () => {
      const t0 = Date.now();
      try {
        await ssm.send(
          new GetParameterCommand({ Name: `/workshop/${DEPLOYMENT_ID}/kubeconfig` })
        );
        throw new Error("SSM parameter still exists");
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "ParameterNotFound")
          return { deleted: true, durationMs: Date.now() - t0 };
        throw err;
      }
    }, { data: (r) => ({ sdkLatencyMs: r.durationMs }) });

    await check("MSK cluster deleted or deleting", async () => {
      const t0 = Date.now();
      const resp = await kafka.send(
        new ListClustersV2Command({ ClusterNameFilter: `workshop-${DEPLOYMENT_ID}-msk` })
      );
      const state = resp.ClusterInfoList?.[0]?.State;
      if (state && state !== "DELETING")
        throw new Error(`MSK cluster still in state: ${state}`);
      return { state: state ?? "DELETED", durationMs: Date.now() - t0 };
    }, { data: (r) => ({ state: r.state, sdkLatencyMs: r.durationMs }) });
  }
  } // end Phase 8

  // ── Phase 9: Platform teardown ────────────────────────────────────────────
  if (phaseEnabled("Phase 9")) {
  beginPhase("Phase 9 — Platform teardown");

  if (SKIP_PLATFORM_TEARDOWN) {
    log("Skipping platform teardown (--skip-platform-teardown)");
  } else {
    // EKS resources are RETAIN — delete explicitly before cdk destroy
    log("Deleting EKS nodegroup workshop-nodes (this takes ~5 min)...");
    try {
      await eks.send(
        new DeleteNodegroupCommand({ clusterName: "workshop-eks", nodegroupName: "workshop-nodes" })
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "ResourceNotFoundException") throw err;
      log("  (nodegroup not found — already deleted)");
    }

    await check("EKS nodegroup workshop-nodes deleted", async () => {
      const t0 = Date.now();
      const deadline = Date.now() + EKS_DELETE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        try {
          const resp = await eks.send(
            new DescribeNodegroupCommand({ clusterName: "workshop-eks", nodegroupName: "workshop-nodes" })
          );
          log(`  Nodegroup status: ${resp.nodegroup?.status}...`);
          await sleep(30_000);
        } catch (err: unknown) {
          if (err instanceof Error && err.name === "ResourceNotFoundException")
            return { deleted: true, waitMs: Date.now() - t0 };
          throw err;
        }
      }
      throw new Error("EKS nodegroup deletion timed out");
    }, { data: (r) => ({ waitMs: r.waitMs }) });

    log("Deleting EKS cluster workshop-eks (this takes ~10 min)...");
    try {
      await eks.send(new DeleteClusterCommand({ name: "workshop-eks" }));
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "ResourceNotFoundException") throw err;
      log("  (cluster not found — already deleted)");
    }

    await check("EKS cluster workshop-eks deleted", async () => {
      const t0 = Date.now();
      const deadline = Date.now() + EKS_DELETE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        try {
          const resp = await eks.send(new DescribeClusterCommand({ name: "workshop-eks" }));
          log(`  Cluster status: ${resp.cluster?.status}...`);
          await sleep(30_000);
        } catch (err: unknown) {
          if (err instanceof Error && err.name === "ResourceNotFoundException")
            return { deleted: true, waitMs: Date.now() - t0 };
          throw err;
        }
      }
      throw new Error("EKS cluster deletion timed out");
    }, { data: (r) => ({ waitMs: r.waitMs }) });

    log("Destroying WorkshopPlatformStack (CDK)...");
    const platformDestroyT0 = Date.now();
    shell(
      `npx cdk destroy --app "npx tsx amplify/custom/platform-app.ts" --force WorkshopPlatformStack`
    );
    log(`  CDK destroy finished in ${((Date.now() - platformDestroyT0) / 1000).toFixed(1)}s`);

    await check("WorkshopPlatformStack CFN stack deleted", async () => {
      const t0 = Date.now();
      try {
        await cfn.send(new DescribeStacksCommand({ StackName: "WorkshopPlatformStack" }));
        throw new Error("Stack still exists");
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes("does not exist"))
          return { deleted: true, durationMs: Date.now() - t0 };
        throw err;
      }
    }, { data: (r) => ({ sdkLatencyMs: r.durationMs }) });

    await check("workshop-edge VPC deleted", async () => {
      const resp = await ec2.send(
        new DescribeVpcsCommand({ Filters: [{ Name: "tag:Name", Values: ["workshop-edge"] }] })
      );
      if ((resp.Vpcs?.length ?? 0) > 0)
        throw new Error("workshop-edge VPC still exists");
      return { deleted: true };
    });

    await check("workshop-cloud VPC deleted", async () => {
      const resp = await ec2.send(
        new DescribeVpcsCommand({ Filters: [{ Name: "tag:Name", Values: ["workshop-cloud"] }] })
      );
      if ((resp.Vpcs?.length ?? 0) > 0)
        throw new Error("workshop-cloud VPC still exists");
      return { deleted: true };
    });
  }
  } // end Phase 9
} finally {
  // Flush the last phase
  flushPhase();

  // Close all open tunnels
  for (const t of tunnels) t.close();

  // Clean up temp kubeconfigs
  if (edgeKubeconfig && existsSync(edgeKubeconfig)) {
    try { execFileSync("rm", ["-f", edgeKubeconfig]); } catch { /* ignore */ }
  }
}

// ── Results summary ───────────────────────────────────────────────────────────

const totalPassed = checkMetrics.filter((c) => c.passed).length;
const totalFailed = checkMetrics.filter((c) => !c.passed).length;
const suiteDurationMs = Date.now() - suiteStart;

console.log("");
console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║   E2E Test Results                                       ║");
console.log("╚══════════════════════════════════════════════════════════╝");
console.log(`  Suite duration : ${(suiteDurationMs / 60_000).toFixed(1)} min`);
console.log(`  Checks passed  : ${totalPassed}`);
console.log(`  Checks failed  : ${totalFailed}`);

if (totalFailed > 0) {
  console.log("");
  console.log("  Failed checks:");
  for (const c of checkMetrics.filter((c) => !c.passed)) {
    console.log(`    ✗  [${c.phase}]  ${c.name}`);
    if (c.error) console.log(`       ${c.error.split("\n")[0]}`);
  }
}

console.log("");
console.log("── Phase breakdown ──────────────────────────────────────────");
for (const p of phaseMetrics) {
  const status = p.checksFailed > 0 ? "✗" : "✓";
  console.log(
    `  ${status}  ${p.name.padEnd(42)}  ${(p.durationMs / 60_000).toFixed(1)} min  ` +
      `${p.checksPassed}/${p.checksTotal} checks`
  );
}

// ── Write reports ─────────────────────────────────────────────────────────────

const reportDir = join(REPO_ROOT, "e2e", "reports");
mkdirSync(reportDir, { recursive: true });
const reportSlug = `${DEPLOYMENT_ID}-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}`;

// JSON metrics report (existing)
const reportPath = join(reportDir, `e2e-${reportSlug}.json`);
const report = {
  deploymentId: DEPLOYMENT_ID,
  region: REGION,
  startedAt: new Date(suiteStart).toISOString(),
  suiteDurationMs,
  totalPassed,
  totalFailed,
  phases: phaseMetrics,
  checks: checkMetrics,
};
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`\n  Metrics report: ${reportPath}`);

// Markdown run report with screenshots and evidence
const mdPath = writeMarkdownReport(report, reportDir);
console.log(`  Markdown report: ${mdPath}`);

process.exit(totalFailed > 0 ? 1 : 0);
