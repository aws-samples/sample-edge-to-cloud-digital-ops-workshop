import { App } from "aws-cdk-lib";
import { PlatformStack } from "./platform-stack";

// Standalone CDK app for the shared platform infrastructure.
// Deploy once per account/region before running participant sandboxes:
//   npx cdk deploy --app "npx tsx amplify/custom/platform-app.ts" WorkshopPlatformStack
//
// scripts/sandbox.sh calls this automatically when the stack doesn't exist yet.
//
// Pass --context eksAdminPrincipalArns=arn1,arn2 (or set
// WORKSHOP_EKS_ADMIN_PRINCIPAL_ARNS as a comma-separated env var) to grant
// cluster-scoped EKS access to CI/facilitator roles that aren't the one that
// originally created the cluster. See PlatformStackProps.eksAdminPrincipalArns.
const app = new App();

const eksAdminPrincipalArnsRaw =
  app.node.tryGetContext("eksAdminPrincipalArns") ??
  process.env.WORKSHOP_EKS_ADMIN_PRINCIPAL_ARNS ??
  "";
const eksAdminPrincipalArns = eksAdminPrincipalArnsRaw
  .split(",")
  .map((arn: string) => arn.trim())
  .filter((arn: string) => arn.length > 0);

new PlatformStack(app, "WorkshopPlatformStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  eksAdminPrincipalArns,
});

app.synth();
