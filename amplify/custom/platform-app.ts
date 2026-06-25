import { App } from "aws-cdk-lib";
import { PlatformStack } from "./platform-stack";

// Standalone CDK app for the shared platform infrastructure.
// Deploy once per account/region before running participant sandboxes:
//   npx cdk deploy --app "npx tsx amplify/custom/platform-app.ts" WorkshopPlatformStack
//
// scripts/sandbox.sh calls this automatically when the stack doesn't exist yet.
const app = new App();

// Allow sandbox-all.sh to deploy into the existing V2 stack name if present.
const stackName = process.env.PLATFORM_STACK_NAME ?? "WorkshopPlatformStack";

new PlatformStack(app, stackName, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

app.synth();
