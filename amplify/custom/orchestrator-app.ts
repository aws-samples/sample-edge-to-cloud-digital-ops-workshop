import { App } from "aws-cdk-lib";
import { OrchestratorStack } from "./orchestrator-stack";

// Standalone CDK app for the deploy orchestrator (epic #180 / #182).
//
// Deployed ONCE per account, independently of the platform/slot lifecycle:
//
//   npx cdk deploy --app "npx tsx amplify/custom/orchestrator-app.ts" \
//     WorkshopDeployOrchestrator \
//     -c repoCloneUrl=https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop.git
//
// This provisions the `workshop-deploy-orchestrator` CodeBuild project. After
// that, an async deploy is just:
//
//   aws codebuild start-build --project-name workshop-deploy-orchestrator \
//     --environment-variables-override name=WORKSHOP_SLOTS,value=ws-slot00,ws-slot01
//
// (or scripts/trigger-deploy.sh), which returns a build id immediately — the
// pollable handle. See scripts/poll-deploy.sh and .github/workflows/deploy.yml.
//
// SOURCE CREDENTIAL: for a PUBLIC repo (the default aws-samples clone URL),
// CodeBuild clones anonymously — no source credential is required, verified
// live 2026-08-12 (a build's DOWNLOAD_SOURCE phase SUCCEEDED with
// `list-source-credentials` empty). A one-time account/region GitHub source
// credential (PAT or GitHub App connection via `aws codebuild
// import-source-credentials` or the console) is only needed if you (a) point
// repoCloneUrl at a PRIVATE fork, or (b) want CodeBuild to post build status
// back to the PR (ReportBuildStatus). It is an account-level singleton, not
// something this stack creates.

const app = new App();

const repoCloneUrl =
  app.node.tryGetContext("repoCloneUrl") ??
  process.env.WORKSHOP_REPO_CLONE_URL ??
  "https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop.git";

const defaultBranch =
  app.node.tryGetContext("defaultBranch") ??
  process.env.WORKSHOP_DEPLOY_BRANCH ??
  "main";

new OrchestratorStack(app, "WorkshopDeployOrchestrator", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  repoCloneUrl,
  defaultBranch,
});

app.synth();
