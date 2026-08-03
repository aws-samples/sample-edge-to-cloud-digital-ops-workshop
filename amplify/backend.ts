import { defineBackend } from "@aws-amplify/backend";
import { CfnOutput } from "aws-cdk-lib";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { ParticipantStack } from "./custom/participant-stack";

const backend = defineBackend({ auth, data });

// ============================================================================
// BASIC AUTH CONFIGURATION
// ============================================================================

// Disable self-signup - admin creates users manually
const { cfnUserPool, cfnUserPoolClient } = backend.auth.resources.cfnResources;
cfnUserPool.adminCreateUserConfig = {
  allowAdminCreateUserOnly: true,
};

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

// Export the GraphQL URL from the (envless) data stack under a stable name so
// the env-specific ParticipantStack can reference it via Fn.importValue without
// triggering CDK's cross-env-stack reference validation.
new CfnOutput(backend.data.stack, "GraphqlEndpointExport", {
  value: backend.data.graphqlUrl,
  exportName: `workshop-${deploymentId}-graphql-endpoint`,
});

// Publish the GraphQL endpoint to SSM so the e2e/doc-runner tests (and anyone
// else) can resolve it by deployment ID alone, without needing a local
// synthesized app to know the CFN export-name convention.
new StringParameter(backend.data.stack, "GraphqlEndpointSsmParam", {
  parameterName: `/workshop/${deploymentId}/graphql-endpoint`,
  stringValue: backend.data.graphqlUrl,
});

const customResources = backend.createStack("WorkshopCustomResources");

// ParticipantStack has a concrete env, so Vpc.fromLookup resolves correctly
// inside it. The VPC IDs are looked up there, not here.
const participantStack = new ParticipantStack(customResources, `Participant-${deploymentId}`, {
  deploymentId,
  graphqlEndpoint: `workshop-${deploymentId}-graphql-endpoint`,
  env: { account, region },
});

// ParticipantStack resolves the GraphQL endpoint via Fn.importValue on the
// export created above (in the data stack). Because that link is a string
// export name rather than a CDK token reference (deliberate — it dodges CDK's
// cross-env-stack reference validation), CDK has no implicit dependency edge
// and would otherwise deploy Participant first. On a fresh slot the export
// doesn't exist yet, so the import fails and the stack rolls back. Declare the
// ordering explicitly so the data stack (which creates the export) deploys
// first. addDependency only orders deployment; it introduces no token
// reference, so the cross-env validation stays clear.
participantStack.addDependency(backend.data.stack);
