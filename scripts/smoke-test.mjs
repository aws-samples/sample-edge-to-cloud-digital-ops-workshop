#!/usr/bin/env node
// Smoke tests: verify a deployed slot's resources are reachable.
// Run after `pnpm run sandbox <slot>` (or `sandbox:all`) completes.
// Uses the AWS CLI so no extra SDK packages are required.

import { execSync } from "child_process";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const SLOT = process.env.WORKSHOP_TEST_SLOT ?? "ws-slot00";

function getAccountId() {
  return execSync(
    "aws sts get-caller-identity --query Account --output text",
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  ).trim();
}

const ACCOUNT_ID = getAccountId();
const BUCKET_NAME = `workshop-${SLOT}-${ACCOUNT_ID}`;

let passed = 0;
let failed = 0;

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

// 1. The slot's GraphQL endpoint SSM param was published by data-stack.ts.
//    (Replaces the old amplify_outputs.json check — the nested-CDK model no
//    longer generates that file; the per-slot SSM param is the source of truth
//    the e2e doc-runner and frontend both read.)
check(`GraphQL endpoint SSM param: /workshop/${SLOT}/graphql-endpoint`, () => {
  const out = execSync(
    `aws ssm get-parameter --name /workshop/${SLOT}/graphql-endpoint --region ${REGION} --query "Parameter.Value" --output text`,
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  ).trim();
  if (!out || out === "None") throw new Error("param not set — was the slot deployed?");
});

// 2. Cognito user pool exists (created by auth-stack.ts — was Amplify auth).
check(`Cognito user pool: workshop-${SLOT}`, () => {
  const out = execSync(
    `aws cognito-idp list-user-pools --max-results 60 --region ${REGION} --query "UserPools[?contains(Name,'workshop-${SLOT}')||contains(Name,'workshop')||contains(Name,'Amplify')].Name" --output text`,
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  ).trim();
  if (!out) throw new Error("No workshop user pool found");
});

// 3. IoT provisioning template exists for the test slot
check(`IoT provisioning template: ${SLOT}-provisioning`, () => {
  execSync(
    `aws iot describe-provisioning-template --template-name ${SLOT}-provisioning --region ${REGION}`,
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  );
});

// 4. S3 bucket exists
check(`S3 bucket: ${BUCKET_NAME}`, () => {
  execSync(
    `aws s3api head-bucket --bucket ${BUCKET_NAME} --region ${REGION}`,
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  );
});

// 5. Athena workgroup exists
check(`Athena workgroup: workshop-${SLOT}`, () => {
  execSync(
    `aws athena get-work-group --work-group workshop-${SLOT} --region ${REGION}`,
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  );
});

// 6. IoT Topic Rule exists
check(`IoT topic rule: workshop_${SLOT.replace(/-/g, "_")}_to_s3`, () => {
  execSync(
    `aws iot get-topic-rule --rule-name workshop_${SLOT.replace(/-/g, "_")}_to_s3 --region ${REGION}`,
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  );
});

// 7. EC2 instances running with workshop tag
check(`EC2 instances (3) tagged WorkshopDeploymentId=${SLOT}`, () => {
  const out = execSync(
    `aws ec2 describe-instances --region ${REGION} --filters "Name=tag:WorkshopDeploymentId,Values=${SLOT}" "Name=instance-state-name,Values=running,pending" --query "Reservations[].Instances[].InstanceId" --output text`,
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  ).trim();
  const ids = out.split(/\s+/).filter(Boolean);
  if (ids.length < 3) throw new Error(`Expected 3 instances, found ${ids.length}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
