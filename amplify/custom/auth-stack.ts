import { NestedStack, NestedStackProps, RemovalPolicy, CfnOutput } from "aws-cdk-lib";
import {
  UserPool,
  UserPoolClient,
  CfnUserPool,
} from "aws-cdk-lib/aws-cognito";
import {
  IdentityPool,
  UserPoolAuthenticationProvider,
} from "aws-cdk-lib/aws-cognito-identitypool";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

export interface AuthNestedStackProps extends NestedStackProps {
  deploymentId: string;
}

/**
 * Per-slot authentication resources, expressed as plain CDK.
 *
 * This is the CDK equivalent of the Amplify Gen 2 `auth/resource.ts`
 * (`defineAuth`) backend that `ampx sandbox` used to own separately. Bringing
 * it into the platform CDK app as a NestedStack is what lets the whole
 * platform + every slot deploy in a single `cdk deploy` (epic #180 / #181).
 *
 * Mirrors the previous behaviour exactly:
 *  - email login, admin-create-user only (self-signup disabled — see
 *    `backend.ts`'s `allowAdminCreateUserOnly: true`),
 *  - a mutable, optional `preferred_username` attribute,
 *  - an identity pool whose *authenticated* role is what the AppSync API
 *    authorizes (`defaultAuthorizationMode: 'identityPool'` → IAM auth).
 *
 * scripts/create-workshop-user.sh resolves the user pool by name; the pool is
 * named `workshop-<deploymentId>` and the id is also published to SSM
 * (`/workshop/<id>/user-pool-id`) so the script can look it up by slot alone.
 */
export class AuthNestedStack extends NestedStack {
  readonly userPool: UserPool;
  readonly userPoolClient: UserPoolClient;
  readonly identityPool: IdentityPool;

  constructor(scope: Construct, id: string, props: AuthNestedStackProps) {
    super(scope, id, props);

    const { deploymentId } = props;

    this.userPool = new UserPool(this, "UserPool", {
      userPoolName: `workshop-${deploymentId}`,
      signInAliases: { email: true },
      selfSignUpEnabled: false,
      standardAttributes: {
        preferredUsername: { mutable: true, required: false },
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Admin-create-user only — participants are created by
    // scripts/create-workshop-user.sh, never self-signup. This mirrors the
    // `cfnUserPool.adminCreateUserConfig.allowAdminCreateUserOnly = true`
    // override that backend.ts applied to the Amplify-generated pool.
    (this.userPool.node.defaultChild as CfnUserPool).adminCreateUserConfig = {
      allowAdminCreateUserOnly: true,
    };

    this.userPoolClient = this.userPool.addClient("UserPoolClient", {
      userPoolClientName: `workshop-${deploymentId}`,
      authFlows: { userSrp: true },
    });

    // Identity pool — the authenticated role it mints is the IAM identity the
    // AppSync GraphQL API authorizes (matches Amplify's `identityPool` default
    // auth mode). No unauthenticated access.
    this.identityPool = new IdentityPool(this, "IdentityPool", {
      identityPoolName: `workshop_${deploymentId.replace(/-/g, "_")}`,
      allowUnauthenticatedIdentities: false,
      authenticationProviders: {
        userPools: [
          new UserPoolAuthenticationProvider({
            userPool: this.userPool,
            userPoolClient: this.userPoolClient,
          }),
        ],
      },
    });

    // Published so scripts/create-workshop-user.sh and the frontend can resolve
    // auth config by deployment id alone (no amplify_outputs.json needed).
    new StringParameter(this, "UserPoolIdSsmParam", {
      parameterName: `/workshop/${deploymentId}/user-pool-id`,
      stringValue: this.userPool.userPoolId,
    });
    new StringParameter(this, "UserPoolClientIdSsmParam", {
      parameterName: `/workshop/${deploymentId}/user-pool-client-id`,
      stringValue: this.userPoolClient.userPoolClientId,
    });
    new StringParameter(this, "IdentityPoolIdSsmParam", {
      parameterName: `/workshop/${deploymentId}/identity-pool-id`,
      stringValue: this.identityPool.identityPoolId,
    });

    new CfnOutput(this, "UserPoolId", { value: this.userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: this.userPoolClient.userPoolClientId });
    new CfnOutput(this, "IdentityPoolId", { value: this.identityPool.identityPoolId });
  }
}
