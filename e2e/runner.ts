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
 *   pnpm test                              # full run — participant stack only; shared platform stack is left up
 *   pnpm test -- --skip-deploy             # assume stacks already up
 *   pnpm test -- --skip-teardown           # leave everything running after tests
 *   pnpm test -- --delete-platform-stack   # opt-in: also tear down the shared platform stack (VPCs/EKS/MSK)
 *   pnpm test -- --deployment-id ws-slot01
 *   pnpm test -- --session observe         # run only Phase 2 (Session 1: Observe)
 *
 * --session values map to phases:
 *   platform | observe | control | state | analytics | edge | hmi | teardown | platform-teardown | workshop-walkthrough
 *
 * Phase 9 (platform teardown) deletes the shared platform stack — the VPCs, EKS
 * cluster, and MSK cluster that every participant slot depends on. It is
 * off by default so a routine e2e run never takes down shared infrastructure
 * out from under other slots; pass --delete-platform-stack (or set
 * E2E_DELETE_PLATFORM_STACK=true) to opt in.
 *
 * Environment variables:
 *   WORKSHOP_TEST_SLOT          deployment ID (default: ws-e2e-test)
 *   AWS_REGION                  AWS region (default: us-east-1)
 *   E2E_SKIP_DEPLOY             "true" to skip all CDK/sandbox deploy
 *   E2E_SKIP_TEARDOWN           "true" to skip participant teardown
 *   E2E_DELETE_PLATFORM_STACK   "true" to also tear down the shared platform stack (default: false)
 *   E2E_K3S_TIMEOUT_MS          ms to wait for K3s job (default: 1_800_000)
 *   E2E_HELM_TIMEOUT_MS         ms to wait for Helm rollout (default: 600_000)
 *   E2E_HMI_TIMEOUT_MS          ms to wait for HMI SSE events (default: 60_000)
 */

import { execSync, execFileSync, spawn } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { chromium } from "playwright";
import { writeMarkdownReport } from "./report-writer.js";
import { runDocBlocks } from "./doc-runner.js";

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
} from "@aws-sdk/client-eks";
import {
  IoTClient,
  DescribeThingGroupCommand,
  ListThingsInThingGroupCommand,
  DescribeProvisioningTemplateCommand,
  CreateJobCommand,
  DescribeJobExecutionCommand,
  ListJobExecutionsForJobCommand,
  GetIndexingConfigurationCommand,
  UpdateIndexingConfigurationCommand,
} from "@aws-sdk/client-iot";
import {
  IoTDataPlaneClient,
} from "@aws-sdk/client-iot-data-plane";
import {
  KafkaClient,
  ListClustersV2Command,
  GetBootstrapBrokersCommand,
  BatchAssociateScramSecretCommand,
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
// Platform teardown (Phase 9) deletes shared infrastructure other slots depend on —
// it must be explicitly opted into, never run as a side effect of a routine e2e pass.
const DELETE_PLATFORM_STACK =
  !SKIP_TEARDOWN &&
  (process.env.E2E_DELETE_PLATFORM_STACK === "true" || process.argv.includes("--delete-platform-stack"));

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
  "workshop-walkthrough": "Phase 10",
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

function shell(cmd: string, opts?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }) {
  return execSync(cmd, {
    cwd: opts?.cwd ?? REPO_ROOT,
    env: { ...process.env, ...opts?.env },
    stdio: "inherit",
    encoding: "utf8",
    timeout: opts?.timeout,
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
            args: [`s3://${BUCKET_NAME}/job-scripts/${s3ScriptKey}`],
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

    if (failed > 0) {
      // Fetch execution details from the first failed device to surface the real error.
      const firstFailed = failResp.executionSummaries?.[0];
      const thingArn = firstFailed?.thingArn ?? "";
      const thingName = thingArn.split(":thing/")[1] ?? thingArn;
      let details = "";
      if (thingName) {
        try {
          const execResp = await iot.send(
            new DescribeJobExecutionCommand({ jobId, thingName })
          );
          const dm = execResp.execution?.statusDetails?.detailsMap ?? {};
          details = Object.entries(dm).map(([k, v]) => `${k}: ${v}`).join("; ");
        } catch { /* best-effort */ }
      }
      throw new Error(
        `IoT Job ${jobId}: ${failed} device(s) FAILED (${succeeded} succeeded). ` +
        `First failure — ${thingName}: ${details || "(no details)"}`
      );
    }

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
let ACCOUNT_ID = "";
let BUCKET_NAME = "";
let GRAPHQL_ENDPOINT = "";

try {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   Edge Digital Ops Workshop — End-to-End Test Suite      ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  ACCOUNT_ID = (await sts.send(new GetCallerIdentityCommand({}))).Account!;
  BUCKET_NAME = `workshop-platform-${ACCOUNT_ID}`;

  console.log(`  Deployment ID           : ${DEPLOYMENT_ID}`);
  console.log(`  Region                  : ${REGION}`);
  console.log(`  S3 bucket               : ${BUCKET_NAME}`);
  console.log(`  Skip deploy             : ${SKIP_DEPLOY}`);
  console.log(`  Skip teardown           : ${SKIP_TEARDOWN}`);
  console.log(`  Delete platform stack   : ${DELETE_PLATFORM_STACK}`);

  // ── Pre-flight: resolve cross-phase state when running a single session ────
  // Cross-phase variables (thingGroupArn, mskArn, edgeInstance0, etc.) are
  // populated during their respective phases. When --session skips earlier phases,
  // we look them up here so later phases can use them.
  if (SESSION_ARG) {
    thingGroupArn = `arn:aws:iot:${REGION}:${ACCOUNT_ID}:thinggroup/${DEPLOYMENT_ID}-devices`;

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
      `npx cdk deploy --app "npx tsx amplify/custom/platform-app.ts" --require-approval never --output cdk.out-e2e WorkshopPlatformStack`
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
    const deadline = Date.now() + 20 * 60_000; // up to 20 min if cluster is being created
    while (Date.now() < deadline) {
      try {
        const resp = await eks.send(new DescribeClusterCommand({ name: "workshop-eks" }));
        const status = resp.cluster?.status;
        if (status === "ACTIVE") return { status, version: resp.cluster?.version ?? "?", durationMs: Date.now() - t0 };
        log(`  EKS cluster status: ${status} — waiting...`);
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "ResourceNotFoundException") {
          log("  EKS cluster not found — waiting for creation...");
        } else throw err;
      }
      await sleep(30_000);
    }
    throw new Error("EKS cluster did not become ACTIVE within 20 min");
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

  await check("IoT Fleet Indexing REGISTRY_AND_SHADOW + $package shadow", async () => {
    const t0 = Date.now();
    const resp = await iot.send(new GetIndexingConfigurationCommand({}));
    const cfg = resp.thingIndexingConfiguration!;
    if (cfg.thingIndexingMode !== "REGISTRY_AND_SHADOW")
      throw new Error(`Unexpected indexing mode: ${cfg.thingIndexingMode}`);
    const namedShadows = cfg.filter?.namedShadowNames ?? [];
    if (!namedShadows.includes("$package")) {
      // Auto-fix: add $package to the named shadow filter
      await iot.send(new UpdateIndexingConfigurationCommand({
        thingIndexingConfiguration: {
          ...cfg,
          filter: { namedShadowNames: [...namedShadows, "$package"] },
        },
      }));
    }
    return { mode: cfg.thingIndexingMode, namedShadows: [...namedShadows, "$package"].filter((v, i, a) => a.indexOf(v) === i), durationMs: Date.now() - t0 };
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

  // These SSM parameters are written by the CDK stacks themselves (not by this
  // test), so resolving them here proves a deployment slot is fully discoverable
  // from just its deployment ID — e.g. to run the walkthrough against a slot that
  // was deployed by someone else, from a different machine, with no local
  // amplify_outputs.json / synthesized CDK app in this working directory.
  await check("Deployment config resolvable via SSM (no local build output)", async () => {
    const t0 = Date.now();
    const names = [
      "graphql-endpoint",
      "deployment-id",
      "claim-secret-arn",
      "eks-cluster-name",
      "msk-cred-secret-arn",
      "shared-bucket-name",
    ].map((suffix) => `/workshop/${DEPLOYMENT_ID}/${suffix}`);
    const values = await Promise.all(
      names.map((name) => ssm.send(new GetParameterCommand({ Name: name })))
    );
    const missing = names.filter((_, i) => !values[i].Parameter?.Value);
    if (missing.length > 0) throw new Error(`Missing SSM parameters: ${missing.join(", ")}`);
    GRAPHQL_ENDPOINT = values[0].Parameter!.Value!;
    return { graphqlEndpoint: GRAPHQL_ENDPOINT, durationMs: Date.now() - t0 };
  }, { data: (r) => ({ graphqlEndpoint: r.graphqlEndpoint, sdkLatencyMs: r.durationMs }) });
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

  thingGroupArn = `arn:aws:iot:${REGION}:${ACCOUNT_ID}:thinggroup/${DEPLOYMENT_ID}-devices`;

  await check("IoT provisioning template exists", async () => {
    const t0 = Date.now();
    const resp = await iot.send(
      new DescribeProvisioningTemplateCommand({ templateName: `${DEPLOYMENT_ID}-provisioning` })
    );
    return { templateArn: resp.templateArn!, durationMs: Date.now() - t0 };
  }, { data: (r) => ({ sdkLatencyMs: r.durationMs }) });

  await check(`S3 bucket ${BUCKET_NAME} exists`, async () => {
    const t0 = Date.now();
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET_NAME }));
    return { durationMs: Date.now() - t0 };
  }, { data: (r) => ({ sdkLatencyMs: r.durationMs }) });

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
      new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: "telemetry/", MaxKeys: 10 })
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
      new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: "telemetry/", MaxKeys: 5 })
    ).catch(() => null);
    s3SampleKey = listing?.Contents?.[0]?.Key;
    return { objectCount: s3ObjectCount };
  }, { data: (r) => r });

  // Capture one MQTT-via-S3 telemetry message as evidence
  if (s3SampleKey) {
    try {
      const obj = await s3.send(new GetObjectCommand({
        Bucket: BUCKET_NAME,
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

  const docSubs = { DEPLOYMENT_ID, ACCOUNT_ID, SHARED_BUCKET: `workshop-platform-${ACCOUNT_ID}`, REGION, GRAPHQL_ENDPOINT };

  await runDocBlocks(
    `${REPO_ROOT}/workshop/02-control/block-2-iot-job.md`,
    docSubs,
    REPO_ROOT,
    (r) => {
      const label = `block-2-iot-job block ${r.blockIndex + 1}`;
      if (r.passed) {
        checkMetrics.push({ name: label, phase: currentPhase, passed: true, durationMs: r.durationMs });
        phaseChecksPassed++;
        phaseChecksTotal++;
        console.log(`  ✓  ${label}  [${r.durationMs}ms]`);
      } else {
        checkMetrics.push({ name: label, phase: currentPhase, passed: false, durationMs: r.durationMs, error: r.error });
        phaseChecksFailed++;
        phaseChecksTotal++;
        console.error(`  ✗  ${label}  [${r.durationMs}ms]`);
        console.error(`       ${r.error}`);
      }
    }
  );
  } // end Phase 3

  // ── Phase 4: Session 3 — State ────────────────────────────────────────────
  if (phaseEnabled("Phase 4")) {
  beginPhase("Phase 4 — Session 3: State");

  const docSubsPhase4 = { DEPLOYMENT_ID, ACCOUNT_ID, SHARED_BUCKET: `workshop-platform-${ACCOUNT_ID}`, REGION, GRAPHQL_ENDPOINT };

  await runDocBlocks(
    `${REPO_ROOT}/workshop/03-state/block-2-shadow-job.md`,
    docSubsPhase4,
    REPO_ROOT,
    (r) => {
      const label = `block-2-shadow-job block ${r.blockIndex + 1}`;
      if (r.passed) {
        checkMetrics.push({ name: label, phase: currentPhase, passed: true, durationMs: r.durationMs });
        phaseChecksPassed++;
        phaseChecksTotal++;
        console.log(`  ✓  ${label}  [${r.durationMs}ms]`);
      } else {
        checkMetrics.push({ name: label, phase: currentPhase, passed: false, durationMs: r.durationMs, error: r.error });
        phaseChecksFailed++;
        phaseChecksTotal++;
        console.error(`  ✗  ${label}  [${r.durationMs}ms]`);
        console.error(`       ${r.error}`);
      }
    }
  );
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

  // Retrieve MSK credentials and bootstrap brokers — the MSK cluster is shared
  // across all participants and is named workshop-platform-msk in the platform stack.
  const mskClustersResp = await kafka.send(
    new ListClustersV2Command({ ClusterNameFilter: "workshop-platform-msk" })
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

    // Ensure the SCRAM secret for this deployment slot is associated with the MSK cluster.
    // MSK only accepts SASL/SCRAM auth from explicitly associated secrets — listing the
    // secret in Secrets Manager isn't enough; it must be batch-associated with the cluster.
    try {
      await kafka.send(new BatchAssociateScramSecretCommand({
        ClusterArn: mskArn,
        SecretArnList: [secretResp.ARN ?? `arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:AmazonMSK_workshop-${DEPLOYMENT_ID}`],
      }));
    } catch { /* already associated or transient — non-fatal */ }

    // Create the MSK topics if they don't exist yet.
    // RisingWave's CREATE SOURCE fails if the topic is absent, so we pre-create them.
    // MSK is only accessible from within the cloud VPC, so we run a short-lived
    // Python pod inside EKS (same VPC) that uses confluent-kafka to create the topics.
    // Run before the doc's deploy steps so the RisingWave DDL step (which creates
    // sources against these topics) doesn't race topic creation.
    try {
      shell(
        `kubectl --kubeconfig ${cloudKcPath} create namespace ${DEPLOYMENT_ID} --dry-run=client -o yaml | kubectl --kubeconfig ${cloudKcPath} apply -f -`
      );
    } catch (e) {
      log(`⚠  Cloud namespace create failed (EKS may not have nodes yet): ${(e as Error).message?.slice(0, 120)}`);
    }
    log("Creating MSK topics (sensors.raw.sim, raw.telemetry) via EKS pod (idempotent)...");
    const REQUIRED_TOPICS = ["sensors.raw.sim", "raw.telemetry"];
    // Build the script as real Python source (newlines preserved) then base64-encode it
    // so it survives being passed through kubectl --command -- python3 -c "..."
    // without indentation/continuation errors.
    const mskTopicSource = [
      `import subprocess,sys`,
      `subprocess.check_call([sys.executable,'-m','pip','install','-q','--root-user-action=ignore','confluent-kafka'])`,
      `from confluent_kafka.admin import AdminClient,NewTopic`,
      `conf={'bootstrap.servers':${JSON.stringify(mskBootstrap)},'security.protocol':'SASL_SSL','sasl.mechanism':'SCRAM-SHA-512','sasl.username':${JSON.stringify(`workshop-${DEPLOYMENT_ID}`)},'sasl.password':${JSON.stringify(mskCreds.password)}}`,
      `a=AdminClient(conf)`,
      `existing=a.list_topics(timeout=15).topics.keys()`,
      `new_topics=[NewTopic(t,num_partitions=4,replication_factor=2) for t in ${JSON.stringify(REQUIRED_TOPICS)} if t not in existing]`,
      `if new_topics:`,
      `    fs=a.create_topics(new_topics)`,
      `    for t,f in fs.items():`,
      `        try: f.result(); print('Created',t)`,
      `        except Exception as e: print('Failed',t,e)`,
      `else:`,
      `    print('All topics already exist')`,
      `print('Topics confirmed:',sorted([t for t in a.list_topics(timeout=10).topics.keys() if t in ${JSON.stringify(REQUIRED_TOPICS)}]))`,
    ].join("\n");
    const mskTopicB64 = Buffer.from(mskTopicSource).toString("base64");
    shellOutput(
      `kubectl --kubeconfig ${cloudKcPath} run msk-topic-init ` +
      `--rm -i --restart=Never -n ${DEPLOYMENT_ID} ` +
      `--image=python:3.12-slim ` +
      `--command -- python3 -c "exec(__import__('base64').b64decode('${mskTopicB64}').decode())" 2>&1`
    );
    log("  MSK topic creation complete");

    // Delete a pre-existing RisingWave CR and wait for pods to terminate before
    // clearing S3 — avoids (1) cluster_id conflicts when pods restart into an
    // empty bucket, and (2) DROP MATERIALIZED VIEW blocking on stale streaming
    // state. The doc's deploy steps below always start from a fresh CR.
    shellOutput(
      `kubectl --kubeconfig ${cloudKcPath} delete risingwave risingwave-cloud -n ${DEPLOYMENT_ID} --ignore-not-found 2>&1 || true`
    );
    shellOutput(
      `kubectl --kubeconfig ${cloudKcPath} wait pod -n ${DEPLOYMENT_ID} ` +
      `-l risingwave.risingwavelabs.com/cr-name=risingwave-cloud ` +
      `--for=delete --timeout=120s 2>/dev/null || true`
    );
    shellOutput(
      `aws s3 rm s3://workshop-${DEPLOYMENT_ID}-${ACCOUNT_ID}-risingwave-state/ --recursive --region ${REGION} 2>/dev/null || true`
    );

    // Run the documented deploy steps from workshop/04-analytics/block-1-deploy.md
    // verbatim — this is the actual workshop script participants run by hand,
    // so passing here proves the doc (not a parallel reimplementation) works.
    const docSubsPhase5 = { DEPLOYMENT_ID, ACCOUNT_ID, SHARED_BUCKET: `workshop-platform-${ACCOUNT_ID}`, REGION, GRAPHQL_ENDPOINT };
    await runDocBlocks(
      `${REPO_ROOT}/workshop/04-analytics/block-1-deploy.md`,
      docSubsPhase5,
      REPO_ROOT,
      (r) => {
        const label = `block-1-deploy block ${r.blockIndex + 1}`;
        if (r.passed) {
          checkMetrics.push({ name: label, phase: currentPhase, passed: true, durationMs: r.durationMs });
          phaseChecksPassed++;
          phaseChecksTotal++;
          console.log(`  ✓  ${label}  [${r.durationMs}ms]`);
        } else {
          checkMetrics.push({ name: label, phase: currentPhase, passed: false, durationMs: r.durationMs, error: r.error });
          phaseChecksFailed++;
          phaseChecksTotal++;
          console.error(`  ✗  ${label}  [${r.durationMs}ms]`);
          console.error(`       ${r.error}`);
        }
      }
    );

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

    await check("Cloud RisingWave mv_sensor_fleet_latest exists and queryable", async () => {
      shellOutput(`lsof -ti:14567 | xargs kill -9 2>/dev/null || true`);
      await sleep(1_000);
      const rwPfProc = spawn(
        "kubectl",
        ["--kubeconfig", cloudKcPath, "port-forward", "-n", DEPLOYMENT_ID,
         "svc/risingwave-cloud-frontend", "14567:4567"],
        { stdio: "ignore" }
      );
      const rwPfTunnel = { localPort: 14567, proc: rwPfProc, close: () => { try { rwPfProc.kill(); } catch { /* */ } } };
      tunnels.push(rwPfTunnel);
      let rwCloudClient: pg.Client | undefined;
      try {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          try {
            rwCloudClient = new pg.Client({ host: "localhost", port: 14567, user: "root", database: "dev", password: "", connectionTimeoutMillis: 2000 });
            await rwCloudClient.connect();
            break;
          } catch { rwCloudClient = undefined; await sleep(1_000); }
        }
        if (!rwCloudClient) throw new Error("Timed out waiting for RisingWave port-forward on 14567");
        const { rows, durationMs } = await pgQuery(rwCloudClient, "SELECT COUNT(*) AS cnt FROM mv_sensor_fleet_latest");

        // Capture a sample of rows from the view as evidence (up to 5)
        try {
          const { rows: sampleRows } = await pgQuery(
            rwCloudClient,
            "SELECT * FROM mv_sensor_fleet_latest ORDER BY ts_ms DESC LIMIT 5"
          );
          if (sampleRows.length > 0)
            capture("mv_sensor_fleet_latest rows (cloud)", JSON.stringify(sampleRows, null, 2));
        } catch { /* evidence is best-effort */ }

        return { rowCount: Number(rows[0].cnt), queryMs: durationMs };
      } finally {
        await rwCloudClient?.end().catch(() => {});
        rwPfTunnel.close();
        tunnels.splice(tunnels.indexOf(rwPfTunnel), 1);
      }
    }, { data: (r) => ({ rowCount: r.rowCount, queryMs: r.queryMs }) });

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
      // Kill any stale port-forward from a prior run on the same port
      shellOutput(`lsof -ti:14568 | xargs kill -9 2>/dev/null || true`);
      await sleep(1_000);
      const rwCloudPf2 = spawn(
        "kubectl",
        ["--kubeconfig", cloudKcPath, "port-forward", "-n", DEPLOYMENT_ID,
         "svc/risingwave-cloud-frontend", "14568:4567"],
        { stdio: "ignore" }
      );
      const rwCloudTunnel2 = { localPort: 14568, proc: rwCloudPf2, close: () => { try { rwCloudPf2.kill(); } catch { /* */ } } };
      tunnels.push(rwCloudTunnel2);
      // Poll until the port-forward is accepting connections (up to 60s)
      let rwCloudPfReady = false;
      const rwCloudPfDeadline = Date.now() + 60_000;
      while (Date.now() < rwCloudPfDeadline) {
        try {
          const c = new pg.Client({ host: "localhost", port: 14568, user: "root", database: "dev", password: "", connectionTimeoutMillis: 2000 });
          await c.connect();
          await c.end();
          rwCloudPfReady = true;
          break;
        } catch { await sleep(1_000); }
      }
      if (!rwCloudPfReady) {
        log("⚠  RisingWave port-forward on 14568 not ready after 60s — skipping cloud freshness checks");
        rwCloudTunnel2.close();
        tunnels.splice(tunnels.indexOf(rwCloudTunnel2), 1);
      }

      if (rwCloudPfReady) {
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
      await (async () => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          try {
            const c = new pg.Client({ host: "localhost", port: 15432, user: "workshop", database: "edge", password: tsdbPassword, connectionTimeoutMillis: 2000 });
            await c.connect();
            await c.end();
            return;
          } catch { await sleep(1_000); }
        }
        throw new Error("Timed out waiting for TimescaleDB port-forward on 15432");
      })();

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
    await check("Freshness ladder: streaming DBs >> Datalake", async () => {
      const rw   = rwCloudFreshnessMs;
      const tsdb = tsdbCloudFreshnessMs;
      const s3   = athenaFreshnessMs;
      if (rw == null || tsdb == null || s3 == null) {
        throw new Error(`Missing freshness readings — rw=${rw} tsdb=${tsdb} s3=${s3}`);
      }
      // Both streaming stores must be <10s and at least 5× fresher than the datalake.
      // RW vs TSDB ordering is not guaranteed in a single sample (sequential queries +
      // 1 Hz publish means a new message can arrive between the two reads).
      const RW_MAX_MS = 10_000;
      const TSDB_MAX_MS = 10_000;
      const MIN_S3_RATIO = 5;
      if (rw > RW_MAX_MS) {
        throw new Error(`RisingWave freshness too stale: ${rw}ms (expected < ${RW_MAX_MS}ms)`);
      }
      if (tsdb > TSDB_MAX_MS) {
        throw new Error(`TimescaleDB freshness too stale: ${tsdb}ms (expected < ${TSDB_MAX_MS}ms)`);
      }
      if (s3 < rw * MIN_S3_RATIO) {
        throw new Error(`S3/Athena not stale enough vs RisingWave: s3=${s3}ms, rw=${rw}ms (expected s3 > rw × ${MIN_S3_RATIO})`);
      }
      if (s3 < tsdb * MIN_S3_RATIO) {
        throw new Error(`S3/Athena not stale enough vs TimescaleDB: s3=${s3}ms, tsdb=${tsdb}ms (expected s3 > tsdb × ${MIN_S3_RATIO})`);
      }
      capture("Data freshness comparison (all tiers)", JSON.stringify({ rw, tsdb, s3 }, null, 2));
      return { risingwave_freshness_ms: rw, timescaledb_freshness_ms: tsdb, datalake_athena_freshness_ms: s3 };
    }, { data: (r) => ({
      rw_ms:   r.risingwave_freshness_ms,
      tsdb_ms: r.timescaledb_freshness_ms,
      s3_ms:   r.datalake_athena_freshness_ms,
    }) });
  } // end mskArn
  } // end Phase 5

  // ── Phase 6: Session 5 — Edge Infrastructure ──────────────────────────────
  if (phaseEnabled("Phase 6")) {
  beginPhase("Phase 6 — Session 5: Edge Infrastructure");

  const k3sJobId = `deploy-k3s-e2e-${Date.now()}`;
  log("Uploading job-scripts/deploy-k3s.sh to S3...");
  shell(`aws s3 cp job-scripts/deploy-k3s.sh s3://${BUCKET_NAME}/job-scripts/deploy-k3s.sh`);

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
    const r = await kafka.send(new ListClustersV2Command({ ClusterNameFilter: "workshop-platform-msk" }));
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

  // Restart the K3s SSM tunnel — it may have idled out during the Helm deploy.
  // Kill the old one (removed from `tunnels`) and open a fresh one.
  log("Restarting SSM tunnel to K3s API before pod readiness checks...");
  k3sTunnel.close();
  const k3sTunnel2 = openSsmTunnel(k3sServerId, 6443, 16443);
  tunnels.push(k3sTunnel2);
  await sleep(30_000); // 30s — give SSM tunnel time to fully establish before TLS kubectl calls

  log("Waiting for edge namespace pods...");
  await waitForPods(edgeKubeconfig, "edge", HELM_TIMEOUT_MS).catch(() =>
    log("⚠  Some edge pods not yet Running — continuing")
  );

  await check("Core edge pods Running (Redpanda, MinIO, RisingWave, ingest/relay)", async () => {
    const out = shellOutput(
      `kubectl --kubeconfig ${edgeKubeconfig} get pods -n edge --no-headers 2>/dev/null || echo ""`
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

  // Poll for sensors.raw.sim topic — rp-connect-ingest needs time to start,
  // subscribe to MQTT, receive first messages, and auto-create the topic.
  await check("sensors.raw.sim topic exists in Redpanda", async () => {
    const t0 = Date.now();
    const topicDeadline = Date.now() + 120_000; // up to 2 min
    let lastTopics = "";
    while (Date.now() < topicDeadline) {
      const pod = shellOutput(
        `kubectl --kubeconfig ${edgeKubeconfig} get pod -n edge -l app.kubernetes.io/name=redpanda --no-headers -o name 2>/dev/null | head -1 | sed 's|pod/||' || echo ""`
      ).trim();
      if (!pod) { await sleep(10_000); continue; }
      const out = shellOutput(
        `kubectl --kubeconfig ${edgeKubeconfig} exec -n edge ${pod} -- rpk topic list 2>/dev/null || true`
      );
      lastTopics = out;
      if (out.includes("sensors.raw.sim")) return { found: true, durationMs: Date.now() - t0 };
      await sleep(15_000);
    }
    throw new Error(`Topic not found after 2 min. Topics: ${lastTopics}`);
  }, { data: (r) => ({ sdkLatencyMs: r.durationMs }) });

  // Sample message count
  await sleep(30_000);
  await check("sensors.raw.sim is receiving messages", async () => {
    const t0 = Date.now();
    const pod = shellOutput(
      `kubectl --kubeconfig ${edgeKubeconfig} get pod -n edge -l app.kubernetes.io/name=redpanda --no-headers -o name 2>/dev/null | head -1 | sed 's|pod/||' || echo ""`
    ).trim();
    if (!pod) throw new Error(`Redpanda pod not found`);
    const out = shellOutput(
      `kubectl --kubeconfig ${edgeKubeconfig} exec -n edge ${pod} -- rpk topic describe sensors.raw.sim 2>/dev/null || echo ""`
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
  const HMI_BUILD_TIMEOUT_MS = 900_000; // 15 min — cross-platform Docker build can be slow
  let hmiBuildFailed = false;
  try {
    // If the HMI tarball already exists in S3, re-use it and skip the slow Docker build.
    // This is safe because the test re-imports from S3 into K3s nodes regardless.
    const s3TarExists = shellOutput(
      `aws s3 ls s3://${BUCKET_NAME}/images/workshop-hmi.tar.gz 2>/dev/null | wc -l || echo 0`
    ).trim() !== "0";
    if (s3TarExists) {
      log("  HMI tarball found in S3 — skipping Docker build, re-importing into nodes...");
      shell(`bash scripts/build-hmi.sh --deployment-id ${DEPLOYMENT_ID} --skip-build`, { timeout: 300_000 });
    } else {
      shell(`bash scripts/build-hmi.sh --deployment-id ${DEPLOYMENT_ID}`, { timeout: HMI_BUILD_TIMEOUT_MS });
    }
    log(`  HMI build+deploy finished in ${((Date.now() - hmiT0) / 1000).toFixed(1)}s`);
  } catch (err: unknown) {
    hmiBuildFailed = true;
    log(`  ⚠ HMI build failed or timed out after ${((Date.now() - hmiT0) / 1000).toFixed(1)}s: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`);
  }
  if (!hmiBuildFailed) {
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
  } // end if (!hmiBuildFailed)
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

    await check("RisingWave state S3 bucket deleted", async () => {
      const rwBucket = `workshop-${DEPLOYMENT_ID}-${ACCOUNT_ID}-risingwave-state`;
      const t0 = Date.now();
      try {
        await s3.send(new HeadBucketCommand({ Bucket: rwBucket }));
        throw new Error(`Bucket ${rwBucket} still exists`);
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

    await check("MSK SCRAM secret deleted or pending delete", async () => {
      const t0 = Date.now();
      try {
        const resp = await sm.send(new DescribeSecretCommand({ SecretId: `AmazonMSK_workshop-${DEPLOYMENT_ID}` }));
        // Secrets Manager enforces a recovery window — PENDING_DELETE counts as deleted for our purposes
        if (resp.DeletedDate) return { deleted: true, pendingDelete: true, durationMs: Date.now() - t0 };
        throw new Error("Secret still active (not scheduled for deletion)");
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "ResourceNotFoundException")
          return { deleted: true, pendingDelete: false, durationMs: Date.now() - t0 };
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

  if (!DELETE_PLATFORM_STACK) {
    log("Skipping platform teardown (pass --delete-platform-stack to opt in)");
  } else {
    // EKS nodegroup/cluster and MSK cluster now delete automatically as part
    // of `cdk destroy` (no RETAIN policy) — no manual pre-deletion needed.

    // Delete all participant Amplify sandbox stacks first — the platform stack
    // exports workshop-platform-msk-arn which participant stacks import.
    // CloudFormation blocks platform stack deletion until all importers are gone.
    log("Deleting participant Amplify sandbox stacks before platform teardown...");
    const sandboxSlots = ["ws-slot00", "ws-slot01", "ws-slot02", "ws-slot03", "ws-slot04"];
    for (const slot of sandboxSlots) {
      try {
        shellOutput(
          `unset npm_config_prefix; . "$HOME/.nvm/nvm.sh"; nvm use 22 --silent; npx ampx sandbox delete --identifier ${slot} -y 2>&1 || true`
        );
        log(`  Sandbox ${slot} delete initiated`);
      } catch { log(`  sandbox ${slot} already gone or delete failed — continuing`); }
    }
    // Wait for sandbox stacks to finish deleting (up to 15 min)
    // Use list-stacks (not describe-stacks) since we don't know the exact hash-suffixed stack name.
    const sandboxDeleteDeadline = Date.now() + 900_000;
    while (Date.now() < sandboxDeleteDeadline) {
      const remaining: string[] = [];
      for (const slot of sandboxSlots) {
        // Stack name contains the slot identifier without hyphens (wsslot00, wsslot01, etc.)
        const slotKey = slot.replace(/-/g, "");
        const activeStacks = shellOutput(
          `aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE DELETE_IN_PROGRESS DELETE_FAILED --query "StackSummaries[?contains(StackName, '${slotKey}')].StackName" --output text 2>/dev/null || echo ""`
        ).trim();
        if (activeStacks && activeStacks !== "None") remaining.push(slot);
      }
      if (remaining.length === 0) break;
      log(`  Waiting for sandbox stacks to finish deleting: ${remaining.join(", ")}...`);
      await sleep(30_000);
    }

    // Directly delete any WorkshopCustomResourcesParticipant stacks that survive sandbox delete.
    // These nested stacks import MSK exports and block platform stack deletion if left behind.
    log("Ensuring WorkshopCustomResourcesParticipant stacks are gone...");
    const participantStacks = shellOutput(
      `aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE --query "StackSummaries[?contains(StackName, 'WorkshopCustomResourcesParticipant')].StackName" --output text 2>/dev/null || echo ""`
    ).trim();
    if (participantStacks && participantStacks !== "None" && participantStacks !== "") {
      for (const stackName of participantStacks.split(/\s+/).filter(Boolean)) {
        log(`  Deleting blocker: ${stackName}`);
        shellOutput(`aws cloudformation delete-stack --stack-name "${stackName}" 2>/dev/null || true`);
      }
      // Wait for them to finish
      const participantDeadline = Date.now() + 300_000;
      while (Date.now() < participantDeadline) {
        const stillActive = shellOutput(
          `aws cloudformation list-stacks --stack-status-filter DELETE_IN_PROGRESS CREATE_COMPLETE --query "StackSummaries[?contains(StackName, 'WorkshopCustomResourcesParticipant')].StackName" --output text 2>/dev/null || echo ""`
        ).trim();
        if (!stillActive || stillActive === "None" || stillActive === "") break;
        log(`  Waiting for participant stacks to delete...`);
        await sleep(15_000);
      }
    }

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

  // ── Phase 10: Workshop walkthrough — aws CLI checks from docs ────────────
  // For each workshop module in order, parse bash code blocks from every
  // block-*.md file, extract aws CLI lines, substitute placeholder values,
  // and run each as a check.  Read-only commands run directly; safe mutating
  // commands (create-job, start-query-execution, etc.) are run with
  // already-exists / duplicate errors treated as passing.
  if (phaseEnabled("Phase 10")) {
  beginPhase("Phase 10 — Workshop walkthrough");

  const READ_ONLY_PREFIXES = [
    "aws iot describe-",
    "aws iot get-",
    "aws iot list-",
    "aws iot search-index",
    "aws iot-data get-thing-shadow",
    "aws s3 ls",
    "aws s3api list-",
    "aws s3api get-",
    "aws s3api head-",
    "aws ec2 describe-",
    "aws ssm get-parameter",
    "aws ssm list-",
    "aws secretsmanager describe-",
    "aws secretsmanager list-",
    "aws secretsmanager get-secret-value",
    "aws kafka describe-",
    "aws kafka list-",
    "aws kafka get-bootstrap-brokers",
    "aws athena get-",
    "aws athena list-",
    "aws eks describe-",
    "aws eks list-",
    "aws cloudformation describe-",
    "aws cloudformation list-",
    "aws glue get-",
    "aws glue list-",
    "aws sts get-caller-identity",
  ];

  // Mutating commands that are safe to run: idempotent or already-exists is OK.
  const MUTATING_PREFIXES = [
    "aws s3 cp",
    "aws iot create-job",
    "aws iot delete-job",
    "aws iot update-indexing-configuration",
    "aws iot-data update-thing-shadow",
    "aws athena start-query-execution",
  ];

  // Errors from mutating commands that are safe to ignore.
  const ALREADY_EXISTS_PATTERNS = [
    /ResourceAlreadyExistsException/,
    /ConflictException/,
    /already exists/i,
    /Job already exists/i,
  ];

  function classifyLine(line: string): "readonly" | "mutating" | null {
    const t = line.trim();
    if (READ_ONLY_PREFIXES.some((p) => t.startsWith(p))) return "readonly";
    if (MUTATING_PREFIXES.some((p) => t.startsWith(p))) return "mutating";
    return null;
  }

  // Extract classified aws command lines from fenced bash/shell code blocks.
  // Handles both top-level fences and indented fences inside MkDocs admonitions
  // (??? example / ??? tip blocks indent code fences with 4 spaces).
  // Multi-line continuations (trailing \) are joined into one command.
  // Strips VAR=$(aws ...) wrappers and output redirects.
  // varName is set when the doc line is a shell assignment: VAR=$(aws ...).
  // The runner executes the inner aws command and stores the raw output in varMap[varName]
  // so that downstream commands referencing $VAR can be substituted at runtime.
  // Assertion attached to a WalkCmd via <!-- e2e:assert {...} --> in the doc.
  // Fields (all optional):
  //   contains   — output must include this substring
  //   notContains — output must NOT include this substring
  //   jsonPath   — dot-path into parsed JSON output (e.g. "status")
  //   equals     — jsonPath value must equal this string
  //   matches    — jsonPath value must match this regex string
  //   jobSucceeds — if true, poll the job-id from the command output until all devices SUCCEED
  interface WalkAssert {
    contains?: string;
    notContains?: string;
    jsonPath?: string;
    equals?: string;
    matches?: string;
    jobSucceeds?: boolean;
  }

  interface WalkCmd { module: string; block: string; cmd: string; kind: "readonly" | "mutating"; varName?: string; assert?: WalkAssert }

  function extractWalkCmds(markdown: string, mod: string, block: string): WalkCmd[] {
    const out: WalkCmd[] = [];
    // Parse <!-- e2e:assert {...} --> comments anywhere in the markdown.
    // Map from fence end-index to the first assert comment that follows it.
    const assertMap = new Map<number, WalkAssert>();
    const assertRe = /<!--\s*e2e:assert\s+(\{[\s\S]*?\})\s*-->/g;
    let am: RegExpExecArray | null;
    while ((am = assertRe.exec(markdown)) !== null) {
      try {
        assertMap.set(am.index, JSON.parse(am[1]) as WalkAssert);
      } catch { /* malformed JSON — skip */ }
    }

    // Capture optional leading indentation (group 1) so we can dedent block content.
    // Backreference \1 ensures the closing fence has the same indentation.
    const fenceRe = /^([ \t]*)```(?:bash|shell|sh)?\s*\n([\s\S]*?)^\1```/gm;
    let match: RegExpExecArray | null;
    while ((match = fenceRe.exec(markdown)) !== null) {
      const indent = match[1];
      const blockContent = match[2];
      const fenceEnd = match.index + match[0].length;

      // Strip block-level indentation from each line so commands parse cleanly.
      const dedented = indent
        ? blockContent.split("\n").map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l)).join("\n")
        : blockContent;
      const joined = dedented.replace(/\\\n\s*/g, " ");

      const cmdsInFence: WalkCmd[] = [];
      for (const raw of joined.split("\n")) {
        // Detect shell variable setter: VAR=$(aws ...)
        const setterMatch = raw.match(/^\s*([A-Z_][A-Z_0-9]*)=\$\(\s*/);
        if (setterMatch) {
          const varName = setterMatch[1];
          let inner = raw.replace(/^\s*\w+=\$\(\s*/, "").replace(/\)\s*$/, "").trim();
          inner = inner.replace(/\s*>>\s*\S+/, "").replace(/\s*>\s*(?!\/dev\/null|\/)(\S+)/, "").trim();
          const kind = classifyLine(inner);
          if (kind) cmdsInFence.push({ module: mod, block, cmd: inner, kind, varName });
          continue;
        }
        let line = raw.trim();
        // Strip output redirects — outfile args on iot-data commands are handled at run-time.
        line = line.replace(/\s*>>\s*\S+/, "").replace(/\s*>\s*(?!\/dev\/null|\/)(\S+)/, "").trim();
        const kind = classifyLine(line);
        if (!kind) continue;
        // Emit commands with bare shell variables — they will be resolved at runtime from varMap.
        cmdsInFence.push({ module: mod, block, cmd: line, kind });
      }

      // Attach the nearest assert comment that appears after this fence's closing backticks.
      // Scan assertMap for the smallest index >= fenceEnd within 500 chars.
      let fenceAssert: WalkAssert | undefined;
      for (const [idx, a] of assertMap) {
        if (idx >= fenceEnd && idx < fenceEnd + 500) {
          fenceAssert = a;
          break;
        }
      }
      // Attach assert to the last command in the fence (the one whose output the doc cares about).
      if (fenceAssert && cmdsInFence.length > 0) {
        cmdsInFence[cmdsInFence.length - 1].assert = fenceAssert;
      }

      for (const c of cmdsInFence) out.push(c);
    }
    return out;
  }

  // Evaluate a WalkAssert against command output. Throws a descriptive error on failure.
  function runAssert(a: WalkAssert, out: string, label: string): void {
    if (a.contains !== undefined && !out.includes(a.contains)) {
      throw new Error(`${label}: expected output to contain "${a.contains}"\nGot: ${out.slice(0, 300)}`);
    }
    if (a.notContains !== undefined && out.includes(a.notContains)) {
      throw new Error(`${label}: expected output NOT to contain "${a.notContains}"\nGot: ${out.slice(0, 300)}`);
    }
    if (a.jsonPath !== undefined) {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(out) as Record<string, unknown>; }
      catch { throw new Error(`${label}: jsonPath assertion requires JSON output, got: ${out.slice(0, 200)}`); }
      const val = a.jsonPath.split(".").reduce<unknown>((o, k) => (o != null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), parsed);
      const strVal = String(val);
      if (a.equals !== undefined && strVal !== a.equals) {
        throw new Error(`${label}: jsonPath "${a.jsonPath}" = "${strVal}", expected "${a.equals}"`);
      }
      if (a.matches !== undefined && !new RegExp(a.matches).test(strVal)) {
        throw new Error(`${label}: jsonPath "${a.jsonPath}" = "${strVal}" did not match /${a.matches}/`);
      }
    }
  }

  // Errors that indicate a resource simply hasn't been provisioned yet — warn
  // rather than hard-fail so Phase 10 can run against a partially-deployed slot.
  const RESOURCE_NOT_FOUND_PATTERNS = [
    /ResourceNotFoundException/,
    /ParameterNotFound/,
    /NoSuchEntityException/,
    /ResourceNotFound/,
    /does not exist/i,
    /not found/i,
  ];

  // Substitute placeholder values baked into the workshop docs with live values.
  function substituteValues(cmd: string): string {
    return cmd
      .replace(/ws-slot\d+/g, DEPLOYMENT_ID)
      .replace(/000000000000/g, ACCOUNT_ID)
      .replace(/\bus-east-1\b/g, REGION);
  }

  const workshopDir = join(REPO_ROOT, "workshop");
  const moduleDirs = readdirSync(workshopDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{2}-/.test(d.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => d.name);

  const walkCommands: WalkCmd[] = [];
  for (const mod of moduleDirs) {
    const modDir = join(workshopDir, mod);
    const blocks = readdirSync(modDir)
      .filter((f) => /^block-\d+.*\.md$/.test(f) || f === "index.md")
      .sort();
    for (const block of blocks) {
      const content = readFileSync(join(modDir, block), "utf8");
      for (const wc of extractWalkCmds(content, mod, block)) {
        walkCommands.push({ ...wc, cmd: substituteValues(wc.cmd) });
      }
    }
  }

  const roCount = walkCommands.filter((c) => c.kind === "readonly").length;
  const mutCount = walkCommands.filter((c) => c.kind === "mutating").length;
  log(`Found ${walkCommands.length} aws commands across workshop docs (${roCount} read-only, ${mutCount} mutating)`);

  // Runtime variable store: varMap[VAR_NAME] = raw command output (trimmed).
  // Populated when a WalkCmd has varName set; consumed when a downstream command
  // contains $VAR_NAME.  Also used to track Athena $QUERY_ID across a block.
  const varMap = new Map<string, string>();

  // Pre-write any /tmp files that the docs create via heredoc (cat > /tmp/...)
  // before the corresponding aws s3 cp commands run.
  const addShadowsJobDoc = JSON.stringify({
    version: "1.0",
    steps: [{
      action: {
        name: "add-shadows",
        type: "runHandler",
        input: {
          handler: "run-script.sh",
          args: [`s3://workshop-platform-${ACCOUNT_ID}/${DEPLOYMENT_ID}/job-scripts/add-shadows.sh`],
        },
        runAsUser: "",
      },
    }],
  }, null, 2);
  writeFileSync("/tmp/add-shadows-job-doc.json", addShadowsJobDoc);

  // Job scripts live in the shared bucket at the root job-scripts/ prefix.
  // Devices only have IAM access to workshop-platform-{ACCOUNT_ID}/job-scripts/*
  // (no slot prefix). The slot prefix appears only in job-docs/ paths.
  const SHARED_BUCKET = `workshop-platform-${ACCOUNT_ID}`;

  const telemetryV3JobDoc = JSON.stringify({
    version: "1.0",
    steps: [{
      action: {
        name: "update-telemetry-precision",
        type: "runHandler",
        input: {
          handler: "run-script.sh",
          args: [`s3://${SHARED_BUCKET}/job-scripts/telemetry-v3.sh`],
        },
        runAsUser: "",
      },
    }],
  }, null, 2);
  writeFileSync("/tmp/telemetry-v3-job-doc.json", telemetryV3JobDoc);

  const telemetryV4JobDoc = JSON.stringify({
    version: "1.0",
    steps: [{
      action: {
        name: "update-telemetry-precision",
        type: "runHandler",
        input: {
          handler: "run-script.sh",
          args: [`s3://${SHARED_BUCKET}/job-scripts/telemetry-v4.sh`],
        },
        runAsUser: "",
      },
    }],
  }, null, 2);
  writeFileSync("/tmp/telemetry-v4-job-doc.json", telemetryV4JobDoc);

  // Extract the combined error text from an execSync failure, which may carry
  // the real error message in err.stdout (when the command uses 2>&1) rather
  // than in err.message (which is just "Command failed: ...").
  function errText(err: unknown): string {
    if (!(err instanceof Error)) return String(err);
    const e = err as Error & { stdout?: Buffer | string; stderr?: Buffer | string };
    return [err.message, e.stdout?.toString(), e.stderr?.toString()].filter(Boolean).join("\n");
  }

  // Validate that important read-only commands returned meaningful data.
  function validateReadOutput(cmd: string, out: string, label: string): void {
    // glue get-tables: must list at least the telemetry table.
    if (cmd.startsWith("aws glue get-tables")) {
      if (!out.includes("telemetry")) throw new Error(`${label}: expected 'telemetry' table in Glue output, got: ${out.slice(0, 200)}`);
    }
    // iot describe-index: must report ACTIVE.
    if (cmd.startsWith("aws iot describe-index")) {
      try {
        const parsed = JSON.parse(out) as { indexStatus?: string };
        if (parsed.indexStatus && parsed.indexStatus !== "ACTIVE") {
          throw new Error(`${label}: Fleet index status is ${parsed.indexStatus}, expected ACTIVE`);
        }
      } catch (e) { if (e instanceof SyntaxError) return; else throw e; }
    }
    // iot search-index: at least one thing returned.
    if (cmd.startsWith("aws iot search-index")) {
      try {
        const parsed = JSON.parse(out) as { things?: unknown[] };
        if (parsed.things !== undefined && parsed.things.length === 0) {
          // Soft warning only — index may not have caught up yet.
          log(`  ⚠  ${label}: search-index returned 0 things (index may be re-building)`);
        }
      } catch { /* non-JSON output is fine */ }
    }
    // iot list-packages: must include our package.
    if (cmd.startsWith("aws iot list-packages")) {
      if (!out.includes(DEPLOYMENT_ID) && !out.includes("telemetry")) {
        log(`  ⚠  ${label}: expected deployment package in list-packages output`);
      }
    }
    // iot list-job-executions-for-job: at least one execution entry.
    if (cmd.startsWith("aws iot list-job-executions-for-job")) {
      try {
        const parsed = JSON.parse(out) as { executionSummaries?: unknown[] };
        if (parsed.executionSummaries !== undefined && parsed.executionSummaries.length === 0) {
          log(`  ⚠  ${label}: no job execution summaries yet`);
        }
      } catch { /* table output — not JSON */ }
    }
    // athena get-query-results: at least a header row present.
    if (cmd.startsWith("aws athena get-query-results")) {
      try {
        const parsed = JSON.parse(out) as { ResultSet?: { Rows?: unknown[] } };
        if (parsed.ResultSet?.Rows !== undefined && parsed.ResultSet.Rows.length <= 1) {
          log(`  ⚠  ${label}: athena get-query-results returned ≤1 rows (data may not be present yet)`);
        }
      } catch { /* table output — not JSON */ }
    }
    // secretsmanager get-secret-value: output must be non-empty.
    // The doc may extract just the password string via --query or python piping, so
    // accept any non-empty output without an error marker.
    if (cmd.startsWith("aws secretsmanager get-secret-value")) {
      const trimmed = out.trim();
      if (!trimmed || /\"errorMessage\"/.test(trimmed)) {
        throw new Error(`${label}: expected secret value in output, got: ${out.slice(0, 200)}`);
      }
    }
    // kafka get-bootstrap-brokers: must contain broker hostname.
    if (cmd.startsWith("aws kafka get-bootstrap-brokers")) {
      if (!out.includes(":9096") && !out.includes(":9092") && !out.includes("bootstrap")) {
        throw new Error(`${label}: expected bootstrap broker endpoint in output, got: ${out.slice(0, 200)}`);
      }
    }
    // cloudformation list-exports: MSK ARN must look like an ARN.
    if (cmd.startsWith("aws cloudformation list-exports") && cmd.includes("msk-arn")) {
      if (!out.includes("arn:aws")) {
        throw new Error(`${label}: expected MSK ARN in cloudformation exports, got: ${out.slice(0, 200)}`);
      }
    }
  }

  // Substitute bare $VAR_NAME references using the runtime varMap.
  // Subshell expressions $(aws ...) are left as-is for the shell to resolve.
  function applyVarMap(cmd: string): string {
    return cmd.replace(/\$([A-Z_][A-Z_0-9]*)/g, (full, name) => {
      const val = varMap.get(name);
      return val !== undefined ? val.trim() : full;
    });
  }

  for (const { module: mod, block, cmd, kind, varName, assert: walkAssert } of walkCommands) {
    // Resolve any bare $VAR references from varMap before running.
    const resolvedRaw = substituteValues(applyVarMap(cmd));

    // Skip the command entirely if it still has unresolved bare $VAR after varMap substitution.
    // (The variable setter itself failed or returned nothing — don't pass an empty arg.)
    const stripped = resolvedRaw.replace(/\$\([^)]+\)/g, "__SUBSHELL__");
    const hasUnresolved = /\$[A-Z_][A-Z_0-9]*/.test(stripped);
    if (hasUnresolved) {
      log(`  ⚠  [${mod}/${block}] Skipping — unresolved variable in: ${resolvedRaw.slice(0, 80)}`);
      continue;
    }
    const safeCmd = resolvedRaw;

    const label = `[${mod}/${block}] ${safeCmd.slice(0, 80)}${safeCmd.length > 80 ? "…" : ""}`;

    if (kind === "readonly") {
      await check(label, async () => {
        const outputFlag = safeCmd.includes("--output") ? "" : " --output json";
        let out: string;
        try {
          out = shellOutput(`${safeCmd}${outputFlag} 2>&1`);
        } catch (err: unknown) {
          const msg = errText(err);
          if (RESOURCE_NOT_FOUND_PATTERNS.some((re) => re.test(msg))) {
            log(`  ⚠  ${label} — resource not found (slot may not have this phase deployed)`);
            return { output: "resource-not-found (skipped)" };
          }
          throw err;
        }

        // If this cmd is a variable setter, capture its output for downstream use.
        if (varName) {
          varMap.set(varName, out.trim());

          // Special case: QUERY_ID setters use `--query QueryExecutionId --output text` so
          // the output IS the raw execution ID string.  Poll until SUCCEEDED before continuing.
          if (varName === "QUERY_ID") {
            const execId = out.trim();
            if (execId) {
              const deadline = Date.now() + 60_000;
              while (Date.now() < deadline) {
                await sleep(2_000);
                try {
                  const execOut = shellOutput(
                    `aws athena get-query-execution --query-execution-id ${execId} --output json 2>&1`
                  );
                  const state = (JSON.parse(execOut) as { QueryExecution?: { Status?: { State?: string } } })
                    ?.QueryExecution?.Status?.State;
                  if (state === "SUCCEEDED" || state === "FAILED" || state === "CANCELLED") break;
                } catch { break; }
              }
            }
          }
        }

        // Response validation for key checks.
        validateReadOutput(safeCmd, out, label);

        // Doc-embedded assertion (<!-- e2e:assert {...} -->).
        if (walkAssert) runAssert(walkAssert, out, label);

        return { output: out.slice(0, 300) };
      });

    } else {
      // Mutating command — run it, treat already-exists as pass.
      await check(label, async () => {
        // aws iot-data update-thing-shadow requires an outfile positional arg.
        let runCmd = safeCmd;
        let shadowOutFile: string | undefined;
        if (safeCmd.startsWith("aws iot-data update-thing-shadow") && !safeCmd.includes("/tmp/")) {
          shadowOutFile = join(tmpdir(), `shadow-update-${Date.now()}.json`);
          runCmd = `${safeCmd} ${shadowOutFile}`;
        }

        // Setter commands (varName set) keep their original --output format so applyVarMap
        // downstream gets a clean value.  Non-setter mutating commands use --output json.
        const outputSuffix = (varName || runCmd.includes("--output")) ? "" : " --output json";
        let out: string;
        let alreadyExisted = false;
        try {
          out = shellOutput(`${runCmd}${outputSuffix} 2>&1`);
        } catch (err: unknown) {
          const msg = errText(err);
          if (ALREADY_EXISTS_PATTERNS.some((re) => re.test(msg))) {
            alreadyExisted = true;
            out = "already-exists (treated as pass)";
          } else if (RESOURCE_NOT_FOUND_PATTERNS.some((re) => re.test(msg))) {
            log(`  ⚠  ${label} — resource not found (slot may not have this phase deployed)`);
            return { output: "resource-not-found (skipped)" };
          } else {
            throw err;
          }
        }

        // For iot create-job, or any command with jobSucceeds:true: poll until all devices succeed.
        // Skip if the job already existed — it may be in a terminal CANCELLED/FAILED state from a prior run.
        const shouldPollJob = !alreadyExisted && (safeCmd.startsWith("aws iot create-job") || walkAssert?.jobSucceeds);
        if (shouldPollJob) {
          try {
            const jobIdMatch = safeCmd.match(/--job-id\s+(\S+)/);
            const walkthroughJobId = jobIdMatch?.[1];
            if (walkthroughJobId) {
              const tgResp = await iot.send(
                new ListThingsInThingGroupCommand({ thingGroupName: `${DEPLOYMENT_ID}-devices` })
              ).catch(() => null);
              const deviceCount = tgResp?.things?.length ?? 1;
              log(`  Waiting for IoT Job ${walkthroughJobId} to complete on ${deviceCount} device(s)...`);
              await waitForIotJob(walkthroughJobId, deviceCount, 600_000);
            }
          } catch (pollErr: unknown) {
            throw new Error(
              `IoT Job created but execution failed: ${pollErr instanceof Error ? pollErr.message : String(pollErr)}`
            );
          }
        }

        // For start-query-execution: extract the execution ID and poll before continuing.
        if (safeCmd.startsWith("aws athena start-query-execution")) {
          try {
            // Output may be raw UUID (--output text) or JSON depending on doc format.
            let execId: string | undefined;
            try { execId = (JSON.parse(out) as { QueryExecutionId?: string }).QueryExecutionId; } catch { /* not JSON */ }
            if (!execId) execId = out.trim(); // raw text output fallback
            if (execId) {
              // Store under both the doc's varName (e.g. QUERY_ID) and the canonical name.
              if (varName) varMap.set(varName, execId);
              varMap.set("QUERY_ID", execId);
              const deadline = Date.now() + 60_000;
              while (Date.now() < deadline) {
                await sleep(2_000);
                const execOut = shellOutput(
                  `aws athena get-query-execution --query-execution-id ${execId} --output json 2>&1`
                );
                const state = (JSON.parse(execOut) as { QueryExecution?: { Status?: { State?: string } } })
                  ?.QueryExecution?.Status?.State;
                if (state === "SUCCEEDED" || state === "FAILED" || state === "CANCELLED") break;
              }
            }
          } catch { /* best-effort */ }
        }

        // For non-athena variable setters, store raw trimmed output.
        if (varName && !safeCmd.startsWith("aws athena start-query-execution")) {
          varMap.set(varName, out.trim());
        }

        if (shadowOutFile) {
          try { capture(`shadow update response (${label})`, readFileSync(shadowOutFile, "utf8")); } catch { /* best-effort */ }
        }

        // Doc-embedded assertion (<!-- e2e:assert {...} -->). Skip when already-existed — the
        // real output was not produced, so asserting against "already-exists (treated as pass)" is meaningless.
        if (walkAssert && !walkAssert.jobSucceeds && !alreadyExisted) runAssert(walkAssert, out, label);

        return { output: out.slice(0, 300) };
      });
    }
  }
  } // end Phase 10
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
