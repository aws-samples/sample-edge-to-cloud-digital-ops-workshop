import { defineBackend } from "@aws-amplify/backend";
import { Stack } from "aws-cdk-lib";
import { auth } from "./auth/resource";
import { PlatformStack } from "./custom/platform-stack";
import { ParticipantStack } from "./custom/participant-stack";

const backend = defineBackend({ auth });

// Amplify custom CDK scope — runs during `ampx sandbox` / pipeline deploy.
// The platform stack creates the two shared VPCs and is deployed once.
// ParticipantStack is deployed once per DEPLOYMENT_ID (default: 10 slots).
const customResources = backend.createStack("WorkshopCustomResources");

const platformStack = new PlatformStack(
  customResources,
  "WorkshopPlatformStack",
  {
    env: {
      account: Stack.of(customResources).account,
      region: Stack.of(customResources).region,
    },
  }
);

// Default deployment count; set WORKSHOP_SLOT_COUNT env var to override.
const slotCount = parseInt(process.env.WORKSHOP_SLOT_COUNT ?? "10", 10);

for (let i = 0; i < slotCount; i++) {
  const deploymentId = `ws-slot${String(i).padStart(2, "0")}`;
  new ParticipantStack(
    customResources,
    `Participant-${deploymentId}`,
    {
      deploymentId,
      edgeVpc: platformStack.edgeVpc,
      cloudVpc: platformStack.cloudVpc,
      env: {
        account: Stack.of(customResources).account,
        region: Stack.of(customResources).region,
      },
    }
  );
}
