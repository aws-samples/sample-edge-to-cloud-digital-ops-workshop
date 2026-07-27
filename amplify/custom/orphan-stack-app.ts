import { App, Stack } from "aws-cdk-lib";

const stackName = process.env.ORPHAN_STACK_NAME;
if (!stackName) {
  throw new Error("ORPHAN_STACK_NAME must be set");
}

const app = new App();
new Stack(app, "OrphanStack", {
  stackName,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
app.synth();
