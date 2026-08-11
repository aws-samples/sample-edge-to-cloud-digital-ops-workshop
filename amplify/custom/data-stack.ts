import { NestedStack, NestedStackProps, CfnOutput } from "aws-cdk-lib";
import {
  GraphqlApi,
  Definition,
  AuthorizationType,
  FieldLogLevel,
  Code,
  FunctionRuntime,
  IamResource,
} from "aws-cdk-lib/aws-appsync";
import { IRole } from "aws-cdk-lib/aws-iam";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

export interface DataNestedStackProps extends NestedStackProps {
  deploymentId: string;
  /**
   * The identity pool's authenticated role — granted `appsync:GraphQL` on this
   * API so authenticated browser sessions can run the publishTelemetry mutation
   * and onTelemetry subscription (matches Amplify's `allow.authenticated()`).
   */
  authenticatedRole: IRole;
}

/**
 * Per-slot AppSync GraphQL API (live-telemetry push path), expressed as plain
 * CDK.
 *
 * This is the CDK equivalent of the Amplify Gen 2 `data/resource.ts`
 * (`defineData`) backend that `ampx sandbox` used to own separately. It hosts
 * the same schema (see `schema.graphql`) with the same three JS resolvers
 * (`data/publishTelemetry.js`, `data/onTelemetrySubscription.js`,
 * `data/healthCheck.js`) on a NONE datasource — a pass-through mutation whose
 * only job is to fan out to the onTelemetry subscription (no persistence).
 *
 * Bringing it into the platform CDK app as a NestedStack is what lets the whole
 * platform + every slot deploy in a single `cdk deploy` (epic #180 / #181), and
 * lets the participant stack receive `graphqlUrl` as a direct prop instead of
 * the old CFN export-name + `Fn.importValue` cross-env workaround.
 */
export class DataNestedStack extends NestedStack {
  readonly api: GraphqlApi;

  constructor(scope: Construct, id: string, props: DataNestedStackProps) {
    super(scope, id, props);

    const { deploymentId, authenticatedRole } = props;

    this.api = new GraphqlApi(this, "GraphqlApi", {
      name: `workshop-${deploymentId}`,
      definition: Definition.fromFile("amplify/custom/schema.graphql"),
      authorizationConfig: {
        // identity-pool (IAM) auth, matching the previous
        // `defaultAuthorizationMode: 'identityPool'`.
        defaultAuthorization: { authorizationType: AuthorizationType.IAM },
      },
      logConfig: { fieldLogLevel: FieldLogLevel.ERROR },
      xrayEnabled: false,
    });

    // NONE datasource — the publishTelemetry mutation doesn't persist; it just
    // returns its arguments so AppSync fires the onTelemetry subscription.
    const noneDs = this.api.addNoneDataSource("NoneDs");

    // The three JS resolvers, reused verbatim from the Amplify data dir so docs
    // and behaviour don't diverge.
    this.api.createResolver("PublishTelemetryResolver", {
      typeName: "Mutation",
      fieldName: "publishTelemetry",
      dataSource: noneDs,
      runtime: FunctionRuntime.JS_1_0_0,
      code: Code.fromAsset("amplify/data/publishTelemetry.js"),
    });

    this.api.createResolver("OnTelemetryResolver", {
      typeName: "Subscription",
      fieldName: "onTelemetry",
      dataSource: noneDs,
      runtime: FunctionRuntime.JS_1_0_0,
      code: Code.fromAsset("amplify/data/onTelemetrySubscription.js"),
    });

    this.api.createResolver("HealthCheckResolver", {
      typeName: "Query",
      fieldName: "healthCheck",
      dataSource: noneDs,
      runtime: FunctionRuntime.JS_1_0_0,
      code: Code.fromAsset("amplify/data/healthCheck.js"),
    });

    // Authenticated identity-pool users may call the API (mutation + sub).
    this.api.grant(authenticatedRole, IamResource.all(), "appsync:GraphQL");

    // e2e/doc-runner resolves the GraphQL endpoint by deployment id alone.
    // Preserved verbatim from the old Amplify data stack (backend.ts).
    new StringParameter(this, "GraphqlEndpointSsmParam", {
      parameterName: `/workshop/${deploymentId}/graphql-endpoint`,
      stringValue: this.api.graphqlUrl,
    });

    new CfnOutput(this, "GraphqlUrl", { value: this.api.graphqlUrl });
    new CfnOutput(this, "GraphqlApiId", { value: this.api.apiId });
  }
}
