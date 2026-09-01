import { App } from "aws-cdk-lib";
import { PlatformStack } from "./platform-stack";
import { AuthNestedStack } from "./auth-stack";
import { DataNestedStack } from "./data-stack";
import { ParticipantStack } from "./participant-stack";

// Standalone CDK app for the shared platform infrastructure PLUS every
// participant slot (epic #180 / #181). One `cdk deploy` of the single
// WorkshopPlatformStack now brings up the shared platform and fans out one set
// of nested stacks per slot — replacing the old two-tier model where
// `ampx sandbox` owned a separate Amplify (auth+data) backend and a top-level
// ParticipantStack per slot.
//
//   npx cdk deploy --app "npx tsx amplify/custom/platform-app.ts" WorkshopPlatformStack
//
// Per slot (deploymentId ws-slotNN) the platform stack now contains three
// nested stacks:
//   - AuthNestedStack   — Cognito user pool + client + identity pool (was
//                         Amplify `defineAuth`)
//   - DataNestedStack   — AppSync GraphQL API + JS resolvers (was Amplify
//                         `defineData`); publishes /workshop/<id>/graphql-endpoint
//   - ParticipantStack  — all per-slot IoT/EC2/MSK/EKS resources (now a
//                         NestedStack; shared platform values + graphqlUrl +
//                         the identity pool's authenticated role arrive as props)
//
// ── Slot list ────────────────────────────────────────────────────────────────
// The set of slots is read from (in priority order):
//   --context slots=ws-slot00,ws-slot01   (cdk -c slots=...)
//   WORKSHOP_SLOTS=ws-slot00,ws-slot01     (env)
//   WORKSHOP_DEPLOYMENT_ID=ws-slot00       (single-slot back-compat)
// If none are set, the platform deploys with zero slots (shared infra only) —
// useful for a first platform-only bring-up.
//
// ── EKS admin principals ──────────────────────────────────────────────────────
// Pass --context eksAdminPrincipalArns=arn1,arn2 (or set
// WORKSHOP_EKS_ADMIN_PRINCIPAL_ARNS as a comma-separated env var) to grant
// cluster-scoped EKS access to CI/facilitator roles that aren't the one that
// originally created the cluster. See PlatformStackProps.eksAdminPrincipalArns.
//
// ── Per-slot trusted principals for WorkshopParticipantRole ────────────────────
// Pass --context participantRoleTrustedPrincipalArns=arn1,arn2 (or set
// WORKSHOP_PARTICIPANT_ROLE_TRUSTED_PRINCIPAL_ARNS) to restrict who may assume
// each slot's WorkshopParticipantRole. Applies to every slot in the list.
const app = new App();

function csvContext(contextKey: string, envKey: string): string[] {
  const raw =
    app.node.tryGetContext(contextKey) ?? process.env[envKey] ?? "";
  return String(raw)
    .split(",")
    .map((s: string) => s.trim())
    .filter((s: string) => s.length > 0);
}

const eksAdminPrincipalArns = csvContext(
  "eksAdminPrincipalArns",
  "WORKSHOP_EKS_ADMIN_PRINCIPAL_ARNS"
);

const participantRoleTrustedPrincipalArns = csvContext(
  "participantRoleTrustedPrincipalArns",
  "WORKSHOP_PARTICIPANT_ROLE_TRUSTED_PRINCIPAL_ARNS"
);

// Slot list: --context slots=, WORKSHOP_SLOTS, or a single WORKSHOP_DEPLOYMENT_ID.
const slots = (() => {
  const fromList = csvContext("slots", "WORKSHOP_SLOTS");
  if (fromList.length > 0) return fromList;
  const single = process.env.WORKSHOP_DEPLOYMENT_ID?.trim();
  return single ? [single] : [];
})();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const platform = new PlatformStack(app, "WorkshopPlatformStack", {
  env,
  eksAdminPrincipalArns,
  // One dedicated rw-compute node per active slot (no autoscaler on this
  // cluster; one r6i.xlarge fits one slot's RW compute pod) — otherwise the
  // 2nd+ slot's compute stays Pending and its DDL can't run (#215). At least 1
  // so a zero-slot / shared-infra-only deploy keeps a warm node.
  rwComputeDesiredSize: Math.max(1, slots.length),
});

for (const deploymentId of slots) {
  // Auth first — the identity pool's authenticated role is what the AppSync API
  // authorizes and is passed into DataNestedStack.
  const auth = new AuthNestedStack(platform, `Auth-${deploymentId}`, {
    deploymentId,
  });

  const data = new DataNestedStack(platform, `Data-${deploymentId}`, {
    deploymentId,
    authenticatedRole: auth.identityPool.authenticatedRole,
  });

  const participant = new ParticipantStack(platform, `Participant-${deploymentId}`, {
    deploymentId,
    // Retained for back-compat / potential future GraphQL consumers. The IoT
    // telemetry bridge Lambda no longer targets this GraphQL API — it publishes
    // to the per-slot AppSync Events API the ParticipantStack creates itself
    // (#259), so ParticipantStack no longer *needs* this prop. CDK wires the
    // cross-nested-stack ref as a parameter when it is used.
    graphqlEndpoint: data.api.graphqlUrl,
    shared: platform.shared,
    participantRoleTrustedPrincipalArns:
      participantRoleTrustedPrincipalArns.length > 0
        ? participantRoleTrustedPrincipalArns
        : undefined,
  });
  // Keep the data stack ordered before the participant stack for stable slot
  // bring-up (the GraphQL API + its SSM endpoint are still per-slot resources
  // the frontend/e2e read), even though the telemetry bridge no longer depends
  // on it now that live-push runs through the Events API (#259).
  participant.node.addDependency(data);
}

app.synth();
