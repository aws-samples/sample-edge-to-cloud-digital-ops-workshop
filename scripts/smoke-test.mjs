#!/usr/bin/env node
// Smoke tests: verify Amplify-deployed resources are reachable.
// Run after `npx ampx sandbox` completes.
// Uses the AWS CLI so no extra SDK packages are required.

import { execSync } from "child_process";
import { existsSync } from "fs";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const SLOT = process.env.WORKSHOP_TEST_SLOT ?? "ws-slot00";

let passed = 0;
let failed = 0;

function cli(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    const msg = e.stderr ? e.stderr.toString().trim().split("\n")[0] : e.message;
    console.error(`  ✗ ${name}: ${msg}`);
    failed++;
  }
}

console.log(`\nSmoke tests for slot: ${SLOT} (region: ${REGION})\n`);

// 1. amplify_outputs.json was generated
check("amplify_outputs.json exists", () => {
  if (!existsSync("amplify_outputs.json")) throw new Error("not found — run npx ampx sandbox first");
});

// 2. Cognito user pool exists (created by Amplify auth)
check("Cognito user pool exists", () => {
  const out = cli(`aws cognito-idp list-user-pools --max-results 60 --region ${REGION} --query "UserPools[?contains(Name,'amplifyAuth')||contains(Name,'workshop')||contains(Name,'Amplify')].Name" --output text`);
  if (!out) throw new Error("No Amplify auth user pool found");
});

// 3. IoT provisioning template exists for the test slot
check(`IoT provisioning template: ${SLOT}-provisioning`, () => {
  cli(`aws iot describe-provisioning-template --template-name ${SLOT}-provisioning --region ${REGION}`);
});

// 4. S3 bucket exists
check(`S3 bucket: workshop-${SLOT}`, () => {
  cli(`aws s3api head-bucket --bucket workshop-${SLOT} --region ${REGION}`);
});

// 5. Athena workgroup exists
check(`Athena workgroup: workshop-${SLOT}`, () => {
  cli(`aws athena get-work-group --work-group workshop-${SLOT} --region ${REGION}`);
});

// 6. IoT Topic Rule exists
check(`IoT topic rule: workshop_${SLOT.replace(/-/g, "_")}_to_s3`, () => {
  cli(`aws iot get-topic-rule --rule-name workshop_${SLOT.replace(/-/g, "_")}_to_s3 --region ${REGION}`);
});

// 7. EC2 instances running with workshop tag
check(`EC2 instances (3) tagged WorkshopDeploymentId=${SLOT}`, () => {
  const out = cli(`aws ec2 describe-instances --region ${REGION} --filters "Name=tag:WorkshopDeploymentId,Values=${SLOT}" "Name=instance-state-name,Values=running,pending" --query "Reservations[].Instances[].InstanceId" --output text`);
  const ids = out.split(/\s+/).filter(Boolean);
  if (ids.length < 3) throw new Error(`Expected 3 instances, found ${ids.length}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
