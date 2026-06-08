import { defineBackend } from "@aws-amplify/backend";
import { auth } from "./auth/resource";
import { ParticipantStack } from "./custom/participant-stack";

const backend = defineBackend({ auth });

// WORKSHOP_DEPLOYMENT_ID is set by scripts/sandbox.sh (e.g. "ws-slot00").
const deploymentId = process.env.WORKSHOP_DEPLOYMENT_ID;
if (!deploymentId) {
  throw new Error(
    "WORKSHOP_DEPLOYMENT_ID must be set. Run: pnpm sandbox (uses scripts/sandbox.sh) or export WORKSHOP_DEPLOYMENT_ID=ws-slot00"
  );
}

// Vpc.fromLookup requires concrete account/region at synth time (not CFN tokens).
// CDK_DEFAULT_ACCOUNT and CDK_DEFAULT_REGION are populated by `ampx sandbox`.
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;
if (!account || !region) {
  throw new Error("CDK_DEFAULT_ACCOUNT and CDK_DEFAULT_REGION must be set");
}

const customResources = backend.createStack("WorkshopCustomResources");

// ParticipantStack has a concrete env, so Vpc.fromLookup resolves correctly
// inside it. The VPC IDs are looked up there, not here.
new ParticipantStack(customResources, `Participant-${deploymentId}`, {
  deploymentId,
  env: { account, region },
});
