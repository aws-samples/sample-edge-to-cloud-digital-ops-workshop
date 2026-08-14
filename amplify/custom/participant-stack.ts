import { NestedStack, NestedStackProps, RemovalPolicy, Duration, CfnOutput, CustomResource, Fn } from "aws-cdk-lib";
import {
  Vpc,
  CfnInstance,
  MachineImage,
  CfnSubnet,
  CfnRouteTable,
  CfnRoute,
  CfnSubnetRouteTableAssociation,
  CfnSecurityGroup,
} from "aws-cdk-lib/aws-ec2";
import {
  Role,
  ServicePrincipal,
  AccountPrincipal,
  ArnPrincipal,
  CompositePrincipal,
  ManagedPolicy,
  PolicyStatement,
  Effect,
  CfnInstanceProfile,
} from "aws-cdk-lib/aws-iam";
import { CfnAccessEntry } from "aws-cdk-lib/aws-eks";
import {
  CfnProvisioningTemplate,
  CfnPolicy as IotPolicy,
  CfnThingGroup,
  CfnSoftwarePackage,
} from "aws-cdk-lib/aws-iot";
import {
  Secret,
} from "aws-cdk-lib/aws-secretsmanager";
import {
  StringParameter,
} from "aws-cdk-lib/aws-ssm";
import {
  Key as KmsKey,
} from "aws-cdk-lib/aws-kms";
import {
  Function as LambdaFn,
  Runtime,
  Code,
  Architecture,
} from "aws-cdk-lib/aws-lambda";
import {
  CfnTopicRule,
} from "aws-cdk-lib/aws-iot";
import {
  AwsCustomResource,
  AwsSdkCall,
  PhysicalResourceId,
  AwsCustomResourcePolicy,
  Provider,
} from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

export interface ParticipantStackProps extends NestedStackProps {
  deploymentId: string;

  /**
   * The slot's AppSync GraphQL endpoint URL. Passed directly from the sibling
   * DataNestedStack (same parent app), so the participant stack no longer needs
   * the old CFN export-name + `Fn.importValue` cross-env workaround. A nested
   * stack cannot `Fn::ImportValue` an export created by its own still-in-progress
   * parent, so all cross-stack values arrive as props (CDK wires them as nested
   * CfnParameters) — see #181.
   */
  graphqlEndpoint: string;

  /**
   * Shared platform resource identifiers, passed in from the parent
   * PlatformStack. Previously resolved via `Fn.importValue` on the platform
   * stack's exports; as a nested stack of the platform stack those exports
   * don't exist yet at create time, so the values are handed down as props
   * (CDK turns cross-stack references into nested-stack parameters).
   */
  readonly shared: {
    bucketName: string;
    bucketArn: string;
    mskClusterArn: string;
    mskBootstrapScram: string;
    mskScramKeyArn: string;
    /**
     * Edge VPC NAT gateway id — the platform stack's `edgeNatGateway.ref`,
     * passed as a real intra-app reference so CDK orders the parent's NAT
     * gateway before this nested stack's default route (previously this was an
     * SSM lookup that could race the platform's own SSM write within a single
     * combined deploy).
     */
    edgeNatGatewayId: string;
  };

  /**
   * IAM principal ARNs (users, roles, or SSO permission sets) trusted to
   * assume this slot's `WorkshopParticipantRole`. Defaults to this account's
   * root, which lets any IAM principal in the account that has been granted
   * `sts:AssumeRole` on the role's ARN assume it — the actual gate is then
   * whichever IAM policy the account admin attaches to their participants,
   * not this stack. Pass explicit ARNs instead to restrict assumption to a
   * specific SSO permission set / IAM group without relying on a separate
   * policy attachment.
   */
  readonly participantRoleTrustedPrincipalArns?: string[];
}

/**
 * All resources scoped to a single workshop slot (deploymentId).
 *
 * Deployed resources:
 *  - Edge subnet (/24) in workshop-edge VPC, private-with-egress (routes to the
 *    shared NAT gateway created in WorkshopPlatformStack; no direct IGW route)
 *  - 3× t3.xlarge EC2 instances with IoT Device Client, fleet provisioning by claim
 *    (sized to run the edge K3s data stack *and* the trimmed kube-prometheus-stack
 *    observability release — a t3.medium node can't hold both; see Session 5 Block 5)
 *  - IoT Provisioning Template + claim cert (stored in Secrets Manager)
 *  - Pre-provisioning hook Lambda
 *  - IoT Dynamic Thing Group
 *  - IoT Rule → shared MSK (raw.telemetry topic, SASL/SCRAM, stamps deployment_id)
 *  - IoT Rule → AppSync bridge Lambda → Amplify GraphQL subscription
 *  - Per-slot MSK SASL/SCRAM secret (references shared cluster + shared KMS key)
 *  - Kubernetes namespace (ws-slotNN) in the shared workshop-eks cluster
 *
 *  - `WorkshopParticipantRole-<deploymentId>` — the IAM role a participant
 *    assumes to run kubectl/helm against their namespace in the shared
 *    workshop-eks cluster, with a namespace-scoped EKS access entry attached
 *
 * Shared infrastructure (S3, MSK cluster, Firehose, Glue, Athena) lives in
 * WorkshopPlatformStack. As of #181 this is a `NestedStack` of the platform
 * CDK app, so those shared values arrive as `props.shared.*` (parent→child
 * CfnParameters) rather than via `Fn.importValue` — a nested stack cannot
 * import an export its own still-in-progress parent creates.
 */
export class ParticipantStack extends NestedStack {
  readonly appSyncBridgeFn: LambdaFn;

  constructor(scope: Construct, id: string, props: ParticipantStackProps) {
    super(scope, id, props);

    const { deploymentId, graphqlEndpoint, shared } = props;

    // Shared platform resources, handed down as props from the parent
    // PlatformStack (see #181). These were previously `Fn.importValue` on the
    // platform stack's CFN exports; as a nested stack those exports don't exist
    // yet at create time, so CDK wires the parent's live references in as nested
    // CfnParameters.
    const {
      bucketName: sharedBucketName,
      bucketArn: sharedBucketArn,
      mskClusterArn,
      mskBootstrapScram,
      mskScramKeyArn,
      edgeNatGatewayId,
    } = shared;

    const edgeVpc = Vpc.fromLookup(this, "WorkshopEdgeVpc", { vpcName: "workshop-edge" });

    // The IoT Kafka rule's VPC destination is created out-of-band (by
    // scripts/create-iot-vpc-dest.sh / the orchestrator) after the shared MSK
    // cluster's brokers are reachable — a CfnTopicRuleDestination can't be
    // confirmed within CloudFormation's stabilisation timeout — and its ARN is
    // published to SSM at `/workshop/platform/iot-vpc-dest-arn`. It is shared
    // across all slots (only one VPC destination is allowed per VPC), so it is
    // still resolved by an SSM lookup rather than passed as a per-slot prop.
    const iotVpcDestSsmLookup = new AwsCustomResource(this, "IotVpcDestSsmLookup", {
      onCreate: {
        service: "SSM",
        action: "getParameter",
        parameters: { Name: "/workshop/platform/iot-vpc-dest-arn" },
        physicalResourceId: PhysicalResourceId.of("IotVpcDestSsmLookup"),
        outputPaths: ["Parameter.Value"],
      },
      onUpdate: {
        service: "SSM",
        action: "getParameter",
        parameters: { Name: "/workshop/platform/iot-vpc-dest-arn" },
        physicalResourceId: PhysicalResourceId.of("IotVpcDestSsmLookup"),
        outputPaths: ["Parameter.Value"],
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/workshop/platform/iot-vpc-dest-arn`],
      }),
    });
    const iotVpcDestArn = iotVpcDestSsmLookup.getResponseField("Parameter.Value");

    // ── IAM roles ────────────────────────────────────────────────────────────
    const ec2Role = new Role(this, "EdgeEc2Role", {
      assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });

    const claimSecret = new Secret(this, "ClaimCertSecret", {
      secretName: `/workshop/${deploymentId}/claim-cert`,
      description: `IoT fleet provisioning claim cert for ${deploymentId}`,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    claimSecret.grantRead(ec2Role);

    const claimCertProvisionerRole = new Role(this, "ClaimCertProvisionerRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });
    claimCertProvisionerRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "iot:CreateKeysAndCertificate",
        "iot:AttachPolicy",
        "iot:DetachPolicy",
        "iot:DescribeCertificate",
        "iot:UpdateCertificate",
        "iot:DeleteCertificate",
      ],
      resources: ["*"],
    }));
    claimCertProvisionerRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["secretsmanager:PutSecretValue"],
      resources: [claimSecret.secretArn],
    }));

    const claimCertProvisionerFn = new LambdaFn(this, "ClaimCertProvisioner", {
      runtime: Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: Code.fromAsset("amplify/lambda/claim-cert-provisioner"),
      timeout: Duration.seconds(60),
      role: claimCertProvisionerRole,
    });

    new CustomResource(this, "ClaimCertResource", {
      serviceToken: claimCertProvisionerFn.functionArn,
      properties: {
        PolicyName: `workshop-${deploymentId}-claim-policy`,
        SecretArn: claimSecret.secretArn,
      },
    });

    ec2Role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["iot:DescribeEndpoint"],
        resources: ["*"],
      })
    );

    ec2Role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "iot:Connect",
          "iot:Publish",
          "iot:Subscribe",
          "iot:Receive",
          "iot:GetThingShadow",
          "iot:UpdateThingShadow",
          "iot:DeleteThingShadow",
        ],
        resources: [`arn:aws:iot:${this.region}:${this.account}:*`],
      })
    );

    // EC2 instances pull job scripts and binaries from the shared S3 bucket.
    ec2Role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["s3:PutObject", "s3:GetObject"],
        resources: [
          `${sharedBucketArn}/job-scripts/*`,
          `${sharedBucketArn}/bin/*`,
          `${sharedBucketArn}/simulator/*`,
          `${sharedBucketArn}/scripts/*`,
          `${sharedBucketArn}/images/*`,
        ],
      })
    );

    ec2Role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["ssm:PutParameter", "ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/workshop/${deploymentId}/*`,
        ],
      })
    );

    ec2Role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["iot:ListThingsInThingGroup"],
        resources: [
          `arn:aws:iot:${this.region}:${this.account}:thinggroup/${deploymentId}-devices`,
        ],
      })
    );

    // ── IoT policies ─────────────────────────────────────────────────────────
    new IotPolicy(this, "ClaimPolicy", {
      policyName: `workshop-${deploymentId}-claim-policy`,
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: "iot:Connect",
            Resource: `arn:aws:iot:${this.region}:${this.account}:client/*`,
          },
          {
            Effect: "Allow",
            Action: "iot:Publish",
            Resource: [
              `arn:aws:iot:${this.region}:${this.account}:topic/$aws/certificates/create/*`,
              `arn:aws:iot:${this.region}:${this.account}:topic/$aws/provisioning-templates/${deploymentId}-provisioning/provision/*`,
            ],
          },
          {
            Effect: "Allow",
            Action: "iot:Subscribe",
            Resource: [
              `arn:aws:iot:${this.region}:${this.account}:topicfilter/$aws/certificates/create/*`,
              `arn:aws:iot:${this.region}:${this.account}:topicfilter/$aws/provisioning-templates/${deploymentId}-provisioning/provision/*`,
            ],
          },
          {
            Effect: "Allow",
            Action: "iot:Receive",
            Resource: [
              `arn:aws:iot:${this.region}:${this.account}:topic/$aws/certificates/create/*`,
              `arn:aws:iot:${this.region}:${this.account}:topic/$aws/provisioning-templates/${deploymentId}-provisioning/provision/*`,
            ],
          },
        ],
      },
    });

    new IotPolicy(this, "DevicePolicy", {
      policyName: `workshop-${deploymentId}-device-policy`,
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: "iot:Connect",
            Resource: `arn:aws:iot:${this.region}:${this.account}:client/\${iot:Connection.Thing.ThingName}`,
          },
          {
            Effect: "Allow",
            Action: ["iot:Publish", "iot:Subscribe", "iot:Receive"],
            Resource: [
              `arn:aws:iot:${this.region}:${this.account}:topic/edge/${deploymentId}/*`,
              `arn:aws:iot:${this.region}:${this.account}:topicfilter/edge/${deploymentId}/*`,
              `arn:aws:iot:${this.region}:${this.account}:topic/$aws/things/\${iot:Connection.Thing.ThingName}/shadow/*`,
              `arn:aws:iot:${this.region}:${this.account}:topicfilter/$aws/things/\${iot:Connection.Thing.ThingName}/shadow/*`,
              `arn:aws:iot:${this.region}:${this.account}:topic/$aws/things/\${iot:Connection.Thing.ThingName}/jobs/*`,
              `arn:aws:iot:${this.region}:${this.account}:topicfilter/$aws/things/\${iot:Connection.Thing.ThingName}/jobs/*`,
              `arn:aws:iot:${this.region}:${this.account}:topic/$aws/jobs/*`,
              `arn:aws:iot:${this.region}:${this.account}:topicfilter/$aws/jobs/*`,
              `arn:aws:iot:${this.region}:${this.account}:topic/$aws/things/\${iot:Connection.Thing.ThingName}/tunnels/notify`,
              `arn:aws:iot:${this.region}:${this.account}:topicfilter/$aws/things/\${iot:Connection.Thing.ThingName}/tunnels/notify`,
            ],
          },
          {
            Effect: "Allow",
            Action: [
              "iot:GetThingShadow",
              "iot:UpdateThingShadow",
              "iot:DeleteThingShadow",
            ],
            Resource: `arn:aws:iot:${this.region}:${this.account}:thing/\${iot:Connection.Thing.ThingName}`,
          },
        ],
      },
    });

    // ── Pre-provisioning hook Lambda ─────────────────────────────────────────
    // Log-only hook needs no IoT/EC2 read permissions — just CloudWatch Logs
    // from the basic execution role.
    const preProvisionLambdaRole = new Role(this, "PreProvisionLambdaRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
    });

    // --8<-- [start:pre-provision-hook]
    // Log-only pre-provisioning hook: it records every provisioning attempt for
    // observability but always allows registration. Participants register their
    // own lab devices (e.g. a Raspberry Pi over SSH — see scripts/register-device-ssh.sh),
    // which have no EC2 instance ID, so the hook must not gate on EC2 identity.
    // The shared claim certificate (delivered to a device by an authenticated
    // operator) is what controls who can register.
    const preProvisionLambda = new LambdaFn(this, "PreProvisionHook", {
      functionName: `workshop-${deploymentId}-pre-provision`,
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      handler: "index.handler",
      code: Code.fromInline(`
const DEPLOYMENT_ID = "${deploymentId}";

exports.handler = async (event) => {
  const thingName = event.parameters?.ThingName;
  const serialNumber = event.parameters?.SerialNumber;

  // Log-only: record the attempt for observability, then always allow.
  console.log(JSON.stringify({
    msg: "provisioning attempt",
    deploymentId: DEPLOYMENT_ID,
    thingName: thingName ?? null,
    serialNumber: serialNumber ?? null,
  }));

  return { allowProvisioning: true };
};
      `),
      role: preProvisionLambdaRole,
      timeout: Duration.seconds(10),
    });

    preProvisionLambda.addPermission("AllowIoTInvoke", {
      principal: new ServicePrincipal("iot.amazonaws.com"),
    });
    // --8<-- [end:pre-provision-hook]

    // ── IoT Provisioning Template ────────────────────────────────────────────
    const provisioningRole = new Role(this, "ProvisioningRole", {
      assumedBy: new ServicePrincipal("iot.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSIoTThingsRegistration"),
      ],
    });

    new CfnThingGroup(this, "DevicesThingGroup", {
      thingGroupName: `${deploymentId}-devices`,
    });

    // ── Software Package Catalog ─────────────────────────────────────────────
    // The telemetry-agent package is the source of truth for what version each
    // device runs. Versions carry a `version` attribute; a job with
    // destinationPackageVersions pointed at one of these publishes it into the
    // device's reserved $package shadow automatically (see PackageConfig in the
    // platform stack). Only 2.0.0 is deployed by a workshop doc today
    // (02-control/block-2 → telemetry-v2.sh); the other versions give the
    // catalog a realistic version history for the fleet-management block.
    const softwarePackage = new CfnSoftwarePackage(this, "TelemetryAgentPackage", {
      packageName: `${deploymentId}-telemetry-agent`,
    });

    const telemetryAgentVersions = ["1.0.0", "2.0.0", "3.0.0", "4.0.0"];
    // Common ARNs for a version's grants: UpdatePackageVersion/CreatePackageVersion
    // authorize against BOTH the package ARN and the version ARN — granting only
    // one yields AccessDenied naming whichever is absent. GetIndexingConfiguration
    // is an account-level read that can't be scoped. Both SDK calls also require
    // GetIndexingConfiguration (per the IoT API reference), and fromSdkCalls can't
    // derive that second action, so every version's policy is built explicitly.
    //
    // The grants below scope to the package-wide version wildcard
    // (`.../version/*`), NOT the single `.../version/N.0.0` ARN, ON PURPOSE.
    // Every AwsCustomResource in this stack shares ONE singleton provider
    // Lambda + role (CDK keys it by a fixed uuid), and each version's `policy:`
    // creates a SEPARATE AWS::IAM::Policy attached to that one role. With
    // per-version ARNs those 8 policies (4 create + 4 publish) are disjoint, so
    // attaching them concurrently races IAM's eventual-consistency window: on a
    // cold slot a provider invocation for one version fired before its own
    // policy had propagated → non-deterministic "iot:UpdatePackageVersion ...
    // not authorized" on whichever version lost the race (observed on a clean
    // ws-slot42 deploy: V2/V3 published, V4 failed — #217). Scoping every grant
    // to `version/*` makes the policies mutually redundant: once ANY one has
    // propagated the role can act on all versions, so no single version's race
    // can fail the deploy.
    const packageArn = `arn:aws:iot:${this.region}:${this.account}:package/${deploymentId}-telemetry-agent`;
    const packageVersionsArn = `${packageArn}/version/*`;
    for (const versionName of telemetryAgentVersions) {
      const logicalId = `TelemetryAgentV${versionName.split(".")[0]}`;

      // The full version lifecycle is custom-resource-driven rather than using
      // the L1 CfnSoftwarePackageVersion. The L1 resource stores the version's
      // `attributes` in CloudFormation state; because a version must be PUBLISHED
      // to be deployable (see the publish resource below) and IoT forbids ANY
      // attribute change on a PUBLISHED version, any later stack operation that
      // re-touches the L1 resource — including a rollback restoring prior
      // attribute values — issues an UpdatePackageVersion that hard-fails with
      // "Attributes cannot be updated for a version in PUBLISHED status",
      // permanently wedging the slot. Managing create/publish/delete as
      // idempotent SDK calls keeps redeploys and rollbacks safe.
      const create = new AwsCustomResource(this, logicalId, {
        onCreate: {
          service: "Iot",
          action: "createPackageVersion",
          parameters: {
            packageName: `${deploymentId}-telemetry-agent`,
            versionName,
            attributes: { version: versionName },
          },
          physicalResourceId: PhysicalResourceId.of(`${logicalId}Create`),
          // A redeploy re-runs onCreate/onUpdate; an existing version returns
          // ConflictException, which is the intended no-op (attributes are never
          // updated on an already-created version — that would fail once PUBLISHED).
          ignoreErrorCodesMatching: "ConflictException",
        },
        onUpdate: {
          service: "Iot",
          action: "createPackageVersion",
          parameters: {
            packageName: `${deploymentId}-telemetry-agent`,
            versionName,
            attributes: { version: versionName },
          },
          physicalResourceId: PhysicalResourceId.of(`${logicalId}Create`),
          ignoreErrorCodesMatching: "ConflictException",
        },
        onDelete: {
          service: "Iot",
          action: "deletePackageVersion",
          parameters: {
            packageName: `${deploymentId}-telemetry-agent`,
            versionName,
          },
          // Tolerate a version already removed out-of-band (e.g. manual cleanup).
          ignoreErrorCodesMatching: "ResourceNotFoundException",
        },
        policy: AwsCustomResourcePolicy.fromStatements([
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ["iot:CreatePackageVersion", "iot:DeletePackageVersion"],
            resources: [packageArn, packageVersionsArn],
          }),
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ["iot:GetIndexingConfiguration"],
            resources: ["*"],
          }),
        ]),
      });
      create.node.addDependency(softwarePackage);

      // Versions are created in DRAFT; a version must be PUBLISHED to be
      // deployable via destinationPackageVersions (see PackageConfig in the
      // platform stack). PUBLISH is idempotent — re-publishing a PUBLISHED
      // version is a no-op, so redeploys are safe.
      const publish = new AwsCustomResource(this, `${logicalId}Publish`, {
        onCreate: {
          service: "Iot",
          action: "updatePackageVersion",
          parameters: {
            packageName: `${deploymentId}-telemetry-agent`,
            versionName,
            action: "PUBLISH",
          },
          physicalResourceId: PhysicalResourceId.of(`${logicalId}Publish`),
        },
        onUpdate: {
          service: "Iot",
          action: "updatePackageVersion",
          parameters: {
            packageName: `${deploymentId}-telemetry-agent`,
            versionName,
            action: "PUBLISH",
          },
          physicalResourceId: PhysicalResourceId.of(`${logicalId}Publish`),
        },
        policy: AwsCustomResourcePolicy.fromStatements([
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ["iot:UpdatePackageVersion"],
            resources: [packageArn, packageVersionsArn],
          }),
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ["iot:GetIndexingConfiguration"],
            resources: ["*"],
          }),
        ]),
      });
      publish.node.addDependency(create);
    }

    // --8<-- [start:provisioning-template]
    const provisioningTemplate = new CfnProvisioningTemplate(this, "ProvisioningTemplate", {
      templateName: `${deploymentId}-provisioning`,
      description: `Fleet provisioning template for deployment ${deploymentId}`,
      enabled: true,
      provisioningRoleArn: provisioningRole.roleArn,
      preProvisioningHook: {
        targetArn: preProvisionLambda.functionArn,
        payloadVersion: "2020-04-01",
      },
      templateBody: JSON.stringify({
        Parameters: {
          ThingName: { Type: "String" },
          SerialNumber: { Type: "String" },
        },
        Resources: {
          certificate: {
            Type: "AWS::IoT::Certificate",
            Properties: {
              CertificateId: { Ref: "AWS::IoT::Certificate::Id" },
              Status: "ACTIVE",
            },
          },
          thing: {
            Type: "AWS::IoT::Thing",
            Properties: {
              ThingName: { Ref: "ThingName" },
              AttributePayload: {
                deploymentId: deploymentId,
              },
              ThingGroups: [`${deploymentId}-devices`],
            },
            OverrideSettings: {
              AttributePayload: "MERGE",
              ThingGroups: "REPLACE",
            },
          },
          policy: {
            Type: "AWS::IoT::Policy",
            Properties: {
              PolicyName: `workshop-${deploymentId}-device-policy`,
            },
          },
        },
      }),
    });
    // The template body references preProvisionLambda.functionArn, so CDK orders
    // it after the *function* — but IoT validates the pre-provisioning hook at
    // template-create time by invoking that Lambda, which requires the
    // AllowIoTInvoke permission to already exist. That permission is a sibling
    // resource with no reference link, so without an explicit dependency it's a
    // race: if the template is created before the permission, IoT returns
    // "Access denied during lambda validation" and the stack rolls back.
    // Depend on the Lambda construct so all its children (including the
    // permission) are created first.
    provisioningTemplate.node.addDependency(preProvisionLambda);
    // --8<-- [end:provisioning-template]

    // ── Edge subnet (private-with-egress /24, network-isolated per slot) ────
    // The slot index (and therefore the CIDR) is derived only from a strict
    // `ws-slotNN` deploymentId. Anything else (e.g. `ws-e2e-test`, whose stray
    // "2" in "e2e" used to be misread as slotIndex 2 — aliasing onto
    // ws-slot02's subnet) fails fast instead of silently colliding with, or
    // defaulting onto, another slot's CIDR.
    const slotIdMatch = /^ws-slot(\d{2})$/.exec(deploymentId);
    if (!slotIdMatch) {
      throw new Error(
        `Unsupported deployment-id format: "${deploymentId}". Expected "ws-slotNN" ` +
          "(e.g. ws-slot00) so the edge subnet CIDR can be derived without risking " +
          "a collision with another slot's subnet."
      );
    }
    const slotIndex = parseInt(slotIdMatch[1], 10);
    // Slot subnets start above the platform-reserved edge-public/edge-private
    // tiers (10.0.0.0/24 - 10.0.5.0/24 for 3 AZs), so offset by 16.
    const edgeSubnetCidr = `10.0.${16 + slotIndex}.0/24`;

    const edgeSubnet = new CfnSubnet(this, "EdgeSubnet", {
      vpcId: edgeVpc.vpcId,
      cidrBlock: edgeSubnetCidr,
      availabilityZone: `${this.region}a`,
      mapPublicIpOnLaunch: false,
      tags: [{ key: "Name", value: `workshop-edge-${deploymentId}` }],
    });

    const edgeRtb = new CfnRouteTable(this, "EdgeRtb", {
      vpcId: edgeVpc.vpcId,
      tags: [{ key: "Name", value: `workshop-edge-${deploymentId}-rtb` }],
    });

    // The edge VPC NAT gateway is created once by the parent platform stack;
    // its id (`props.shared.edgeNatGatewayId`) is passed down as a real
    // intra-app reference so CDK orders the parent's NAT gateway ahead of this
    // default route.
    new CfnRoute(this, "EdgeDefaultRoute", {
      routeTableId: edgeRtb.ref,
      destinationCidrBlock: "0.0.0.0/0",
      natGatewayId: edgeNatGatewayId,
    });

    new CfnSubnetRouteTableAssociation(this, "EdgeSubnetRtbAssoc", {
      subnetId: edgeSubnet.ref,
      routeTableId: edgeRtb.ref,
    });

    const edgeSg = new CfnSecurityGroup(this, "EdgeSg", {
      vpcId: edgeVpc.vpcId,
      groupDescription: `workshop-edge-${deploymentId}`,
      securityGroupIngress: [
        { ipProtocol: "-1", fromPort: -1, toPort: -1, cidrIp: edgeSubnetCidr },
      ],
      securityGroupEgress: [
        { ipProtocol: "-1", fromPort: -1, toPort: -1, cidrIp: "0.0.0.0/0" },
      ],
      tags: [{ key: "Name", value: `workshop-edge-${deploymentId}-sg` }],
    });

    // ── EC2 instances ────────────────────────────────────────────────────────
    const userDataScript = `#!/bin/bash
set -euxo pipefail

yum install -y amazon-ssm-agent 2>/dev/null || true
systemctl enable amazon-ssm-agent && systemctl start amazon-ssm-agent

# #166: the edge VPC's NAT Gateway reaps idle flows after 350s. The device
# client's MQTT socket sits idle between telemetry publishes (those go over
# the HTTPS data plane, not this socket), so with no keepalive traffic below
# 350s the flow gets silently dropped and the client only notices at its
# ~1200s MQTT keep-alive ping, forcing a reconnect that leaves the Jobs
# notify-next subscription stale (see workshop/reference/gotchas.md). Kernel
# TCP keepalive only fires on sockets that opt into SO_KEEPALIVE — the device
# client is patched at build time (scripts/sandbox.sh) to do so — so this
# sysctl tuning is what actually makes those probes fire under 350s.
cat > /etc/sysctl.d/99-workshop-mqtt-keepalive.conf <<'SYSCTL'
net.ipv4.tcp_keepalive_time=200
net.ipv4.tcp_keepalive_intvl=30
net.ipv4.tcp_keepalive_probes=4
SYSCTL
sysctl --system

INSTANCE_ID=$(ec2-metadata --instance-id | cut -d' ' -f2)

mkdir -p /etc/aws-iot-device-client/certs
SECRET_JSON=$(aws secretsmanager get-secret-value \
  --region ${this.region} \
  --secret-id /workshop/${deploymentId}/claim-cert \
  --query SecretString --output text)

echo "$SECRET_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); open('/etc/aws-iot-device-client/certs/claim.pem.crt','w').write(d['certificate']); open('/etc/aws-iot-device-client/certs/claim-private.pem.key','w').write(d['privateKey'])"
chmod 644 /etc/aws-iot-device-client/certs/claim.pem.crt
chmod 600 /etc/aws-iot-device-client/certs/claim-private.pem.key

curl -o /etc/aws-iot-device-client/certs/AmazonRootCA1.pem \
  https://www.amazontrust.com/repository/AmazonRootCA1.pem

IOT_ENDPOINT=$(aws iot describe-endpoint \
  --region ${this.region} \
  --endpoint-type iot:Data-ATS \
  --query endpointAddress --output text)

aws s3 cp "s3://${sharedBucketName}/bin/aws-iot-device-client" /usr/local/bin/aws-iot-device-client --region ${this.region}
chmod +x /usr/local/bin/aws-iot-device-client

# #244: persistent MQTT publisher, installed once at boot. The telemetry loop
# (below) hands it JSON payloads over a bash coprocess pipe instead of
# shelling out to \`aws iot-data publish\` per message.
python3 -m ensurepip --upgrade
pip3 install awsiotsdk
aws s3 cp "s3://${sharedBucketName}/bin/mqtt-publisher.py" /usr/local/bin/mqtt-publisher.py --region ${this.region}
chmod +x /usr/local/bin/mqtt-publisher.py

mkdir -p /etc/aws-iot-device-client/jobs
chmod 700 /etc/aws-iot-device-client/certs

cat > /etc/aws-iot-device-client/aws-iot-device-client.conf <<EOF
{
  "endpoint": "$IOT_ENDPOINT",
  "cert": "/etc/aws-iot-device-client/certs/claim.pem.crt",
  "key": "/etc/aws-iot-device-client/certs/claim-private.pem.key",
  "root-ca": "/etc/aws-iot-device-client/certs/AmazonRootCA1.pem",
  "thing-name": "$INSTANCE_ID",
  "fleet-provisioning": {
    "enabled": true,
    "template-name": "${deploymentId}-provisioning",
    "template-parameters": "{\\"ThingName\\":\\"$INSTANCE_ID\\",\\"SerialNumber\\":\\"$INSTANCE_ID\\"}"
  },
  "jobs": {
    "enabled": true,
    "handler-directory": "/etc/aws-iot-device-client/jobs"
  },
  "shadow": {
    "enabled": true
  },
  "tunneling": {
    "enabled": false
  },
  "logging": {
    "level": "INFO",
    "type": "FILE",
    "file": "/var/log/aws-iot-device-client.log"
  }
}
EOF
chmod 640 /etc/aws-iot-device-client/aws-iot-device-client.conf

cat > /etc/aws-iot-device-client/jobs/run-script.sh <<'HANDLER'
#!/bin/bash
set -euo pipefail
SCRIPT_URI="\${2:-}"
if [[ -z "$SCRIPT_URI" ]]; then
  echo "ERROR: no scriptUri provided as arg" >&2
  exit 1
fi
aws s3 cp "$SCRIPT_URI" /tmp/job-script.sh --region ${this.region}
chmod +x /tmp/job-script.sh
/tmp/job-script.sh
HANDLER
chmod +x /etc/aws-iot-device-client/jobs/run-script.sh

mkdir -p /root/.aws-iot-device-client
ln -sfn /etc/aws-iot-device-client/jobs /root/.aws-iot-device-client/jobs

cat > /etc/aws-iot-device-client/jobs/publish-telemetry.sh <<'TELEMETRY'
#!/bin/bash
INSTANCE_ID=$(ec2-metadata --instance-id | cut -d' ' -f2)
AZ=$(ec2-metadata --availability-zone | cut -d' ' -f2)
REGION="\${AZ%?}"
DEPLOYMENT_ID=$DEPLOYMENT_ID
IOT_ENDPOINT=$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text)
INTERVAL_S=5

# #244: one persistent MQTT connection for the life of this process, instead
# of a new \`aws iot-data publish\` process (+ fresh TLS handshake) per message.
# The client id must differ from the device's own Thing name -- AWS IoT drops
# the OLDER connection on a client-id collision, which would kick the device
# client's Jobs/shadow session offline every time this loop restarts.
coproc MQTT_PUB { python3 /usr/local/bin/mqtt-publisher.py \
  --endpoint "$IOT_ENDPOINT" \
  --region "$REGION" \
  --topic "edge/$DEPLOYMENT_ID/$INSTANCE_ID/telemetry" \
  --client-id "\${INSTANCE_ID}-telemetry-pub"; }

while true; do
  TS=$(date -u +%s%3N)
  CPU=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | tr -d '%us,')
  MEM=$(free | awk '/Mem:/ {printf "%.1f", $3/$2*100}')
  DISK=$(df / | awk 'NR==2 {print $5}' | tr -d '%')

  PAYLOAD=$(printf \
    '{"thing_name":"%s","message_timestamp":%s,"cpu_pct":%s,"mem_used_pct":%s,"disk_used_pct":%s}' \
    "$INSTANCE_ID" "$TS" "$CPU" "$MEM" "$DISK")

  echo "$PAYLOAD" >&"\${MQTT_PUB[1]}" || true

  sleep $INTERVAL_S
done
TELEMETRY
chmod +x /etc/aws-iot-device-client/jobs/publish-telemetry.sh

cat > /etc/systemd/system/workshop-telemetry.service <<EOF
[Unit]
Description=Workshop MQTT Telemetry Publisher
After=network.target

[Service]
Type=simple
EnvironmentFile=-/etc/workshop-telemetry.env
ExecStart=/etc/aws-iot-device-client/jobs/publish-telemetry.sh
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

echo "DEPLOYMENT_ID=${deploymentId}" > /etc/workshop-telemetry.env

cat > /etc/systemd/system/aws-iot-device-client.service <<EOF
[Unit]
Description=AWS IoT Device Client
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/aws-iot-device-client --config-file /etc/aws-iot-device-client/aws-iot-device-client.conf
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# One-time restart after fleet provisioning writes its runtime config, to work
# around an aws-iot-device-client v1.10.x race: the jobs \`notify-next\`
# subscription established during the initial fleet-provisioning session (claim
# cert → CreateKeysAndCertificate → RegisterThing → reconnect with the permanent
# cert) does NOT reliably receive the FIRST job created after connect — the
# execution sits QUEUED indefinitely with zero device-log activity until the
# client is restarted (which fires StartNextPendingJobExecution). Warm/subsequent
# jobs are unaffected. A single restart once the runtime config is in place fixes
# it permanently, so the very first IoT job on a fresh slot runs without any
# manual intervention. Guarded by a sentinel so it only ever runs once. See #103.
cat > /usr/local/bin/iot-post-provision-restart.sh <<'PPR'
#!/bin/bash
set -uo pipefail
SENTINEL=/var/lib/iot-post-provision-restart.done
RUNTIME_CONF=/root/.aws-iot-device-client/aws-iot-device-client-runtime.conf
[[ -f "$SENTINEL" ]] && exit 0
# Wait up to 5 min for fleet provisioning to export the runtime config.
for _ in $(seq 1 60); do
  [[ -f "$RUNTIME_CONF" ]] && break
  sleep 5
done
if [[ -f "$RUNTIME_CONF" ]]; then
  sleep 5
  systemctl restart aws-iot-device-client
fi
mkdir -p "$(dirname "$SENTINEL")"
touch "$SENTINEL"
PPR
chmod +x /usr/local/bin/iot-post-provision-restart.sh

cat > /etc/systemd/system/iot-post-provision-restart.service <<EOF
[Unit]
Description=One-time aws-iot-device-client restart after fleet provisioning (#103)
After=aws-iot-device-client.service
Wants=aws-iot-device-client.service
ConditionPathExists=!/var/lib/iot-post-provision-restart.done

[Service]
Type=oneshot
ExecStart=/usr/local/bin/iot-post-provision-restart.sh
RemainAfterExit=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable aws-iot-device-client workshop-telemetry iot-post-provision-restart
systemctl start aws-iot-device-client workshop-telemetry
systemctl start --no-block iot-post-provision-restart
`;

    const amiId = MachineImage.latestAmazonLinux2023().getImage(this).imageId;
    const encodedUserData = Fn.base64(userDataScript);

    const instanceProfile = new CfnInstanceProfile(this, "EdgeInstanceProfile", {
      roles: [ec2Role.roleName],
    });

    for (let i = 0; i < 3; i++) {
      new CfnInstance(this, `EdgeInstance${i}`, {
        // t3.xlarge (4 vCPU / 16 GiB): the edge K3s node must run the full data
        // stack (Redpanda, RisingWave, TimescaleDB, MinIO, HMI) *and* the trimmed
        // kube-prometheus-stack (Prometheus + Grafana + node-exporter +
        // kube-state-metrics). t3.medium's 2 vCPU / 4 GiB can't fit both. See
        // workshop/05-edge-infra/block-5-observability.md.
        instanceType: "t3.xlarge",
        imageId: amiId,
        subnetId: edgeSubnet.ref,
        securityGroupIds: [edgeSg.ref],
        iamInstanceProfile: instanceProfile.ref,
        userData: encodedUserData,
        blockDeviceMappings: [
          {
            deviceName: "/dev/xvda",
            // 60 GiB: +30 over the pre-observability size to hold Prometheus's
            // local TSDB (short 24h retention, but node-exporter + kube-state
            // series across the stack still need room) alongside the data PVs.
            ebs: { volumeSize: 60, volumeType: "gp3", deleteOnTermination: true },
          },
        ],
        tags: [
          { key: "WorkshopDeploymentId", value: deploymentId },
          { key: "Name", value: `workshop-${deploymentId}-edge-${i}` },
        ],
      });
    }

    // ── Sensor Simulator EC2 ─────────────────────────────────────────────────
    const simulatorUserData = `#!/bin/bash
set -euxo pipefail

systemctl enable amazon-ssm-agent && systemctl start amazon-ssm-agent

dnf install -y gcc gcc-c++ make cmake openssl-devel

cd /tmp
wget -q https://mosquitto.org/files/source/mosquitto-2.0.18.tar.gz -O mosquitto.tar.gz
tar xf mosquitto.tar.gz
cd mosquitto-2.0.18
cmake -B build -DWITH_WEBSOCKETS=OFF -DWITH_DOCS=OFF -DDOCUMENTATION=OFF -DCMAKE_INSTALL_PREFIX=/usr/local
cmake --build build -j$(nproc)
cmake --install build
ldconfig

python3 -m ensurepip --upgrade
pip3 install paho-mqtt

mkdir -p /etc/mosquitto
cat > /etc/mosquitto/mosquitto.conf <<'MQTTCONF'
listener 1883 0.0.0.0
allow_anonymous true
MQTTCONF

cat > /etc/systemd/system/mosquitto.service <<'SVC'
[Unit]
Description=Mosquitto MQTT Broker
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/sbin/mosquitto -c /etc/mosquitto/mosquitto.conf
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SVC

systemctl daemon-reload
systemctl enable mosquitto && systemctl start mosquitto

aws s3 cp s3://${sharedBucketName}/simulator/sensor-sim.py /usr/local/bin/sensor-sim.py --region ${this.region}
chmod +x /usr/local/bin/sensor-sim.py

cat > /etc/systemd/system/sensor-sim.service <<'SVC'
[Unit]
Description=Industrial Sensor Simulator
After=mosquitto.service network.target
Requires=mosquitto.service

[Service]
Type=simple
Environment=MQTT_HOST=localhost
Environment=MQTT_PORT=1883
Environment=SITE_ID=${deploymentId}-sim
ExecStart=/usr/bin/python3 /usr/local/bin/sensor-sim.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
SVC

systemctl daemon-reload
systemctl enable sensor-sim
systemctl start sensor-sim
`;

    new CfnInstance(this, "SensorSimulatorInstance", {
      instanceType: "t3.medium",
      imageId: amiId,
      subnetId: edgeSubnet.ref,
      securityGroupIds: [edgeSg.ref],
      iamInstanceProfile: instanceProfile.ref,
      userData: Fn.base64(simulatorUserData),
      tags: [
        { key: "WorkshopDeploymentId", value: deploymentId },
        { key: "Name", value: `workshop-${deploymentId}-sensor-sim` },
      ],
    });

    // ── AppSync bridge Lambda (live push — no persistence) ───────────────────
    const appSyncBridgeRole = new Role(this, "AppSyncBridgeRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });

    this.appSyncBridgeFn = new LambdaFn(this, "AppSyncBridge", {
      functionName: `workshop-${deploymentId}-appsync-bridge`,
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      handler: "index.handler",
      role: appSyncBridgeRole,
      timeout: Duration.seconds(5),
      environment: {
        // #181: the sibling DataNestedStack's GraphQL URL is passed straight in
        // as a prop (was a CFN export name resolved via Fn.importValue).
        APPSYNC_GRAPHQL_ENDPOINT: graphqlEndpoint,
        DEPLOYMENT_ID: deploymentId,
        REGION: this.region,
      },
      code: Code.fromAsset("amplify/lambda/appsync-bridge"),
    });

    this.appSyncBridgeFn.addPermission("AllowIoTInvoke", {
      principal: new ServicePrincipal("iot.amazonaws.com"),
    });

    new CfnTopicRule(this, "IotToAppSyncRule", {
      ruleName: `workshop_${deploymentId.replace(/-/g, "_")}_to_appsync`,
      topicRulePayload: {
        sql: `SELECT * FROM 'edge/${deploymentId}/+/telemetry'`,
        actions: [
          {
            lambda: {
              functionArn: this.appSyncBridgeFn.functionArn,
            },
          },
        ],
        ruleDisabled: false,
      },
    });

    // ── Per-participant MSK SASL/SCRAM secret ─────────────────────────────────
    // Each participant gets their own credentials on the shared MSK cluster.
    // The secret must use the platform-managed CMK (MSK requirement).
    const mskScramKey = KmsKey.fromKeyArn(this, "MskScramKey", mskScramKeyArn);

    const mskCredSecret = new Secret(this, "MskCredSecret", {
      secretName: `AmazonMSK_workshop-${deploymentId}`,
      description: `MSK SASL/SCRAM credentials for ${deploymentId}`,
      encryptionKey: mskScramKey,
      removalPolicy: RemovalPolicy.DESTROY,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: `workshop-${deploymentId}` }),
        generateStringKey: "password",
        excludePunctuation: true,
      },
    });

    // Register the SCRAM secret with the shared MSK cluster.
    //
    // NOTE: `batchAssociateScramSecret` returns HTTP 200 even when it fails to
    // associate a secret — the per-secret failures come back in the response's
    // `UnprocessedScramSecrets` array. A plain `AwsCustomResource` treats the
    // 200 as success and never inspects that array, so a silent failure (e.g.
    // the secret is not yet KMS-readable when the call fires) leaves the cluster
    // with NO usable SCRAM credential — every downstream SASL/SCRAM login
    // (RisingWave, Redpanda Connect, the IoT Kafka action) then fails with
    // "invalid credentials". We use a Lambda-backed custom resource that polls
    // until the association actually shows up in `listScramSecrets`, and throws
    // (failing the deploy loudly) if it never does.
    const mskAssociateScramLambda = new LambdaFn(this, "MskAssociateScramFn", {
      functionName: `workshop-${deploymentId}-msk-assoc-scram`,
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      handler: "index.handler",
      timeout: Duration.minutes(5),
      code: Code.fromInline(`
const { KafkaClient, BatchAssociateScramSecretCommand, BatchDisassociateScramSecretCommand, ListScramSecretsCommand } = require("@aws-sdk/client-kafka");
const SECRET_ARN = process.env.SECRET_ARN;
const kafka = new KafkaClient({});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isAssociated() {
  let token;
  do {
    const out = await kafka.send(new ListScramSecretsCommand({ ClusterArn: process.env.CLUSTER_ARN, NextToken: token }));
    if ((out.SecretArnList || []).includes(SECRET_ARN)) return true;
    token = out.NextToken;
  } while (token);
  return false;
}

exports.handler = async (event) => {
  const type = event.RequestType;
  if (type === "Delete") {
    try {
      await kafka.send(new BatchDisassociateScramSecretCommand({ ClusterArn: process.env.CLUSTER_ARN, SecretArnList: [SECRET_ARN] }));
    } catch (e) { console.log("disassociate (ignored on delete):", e.message); }
    return { PhysicalResourceId: "MskScramAssoc-" + process.env.SECRET_ARN };
  }

  // Create/Update — associate, then poll listScramSecrets until it sticks.
  // Secret/KMS eventual consistency can make the first attempt land in
  // UnprocessedScramSecrets; retry a handful of times before giving up.
  const MAX = 8;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    if (await isAssociated()) {
      console.log("secret associated after attempt " + attempt);
      return { PhysicalResourceId: "MskScramAssoc-" + process.env.SECRET_ARN };
    }
    const res = await kafka.send(new BatchAssociateScramSecretCommand({ ClusterArn: process.env.CLUSTER_ARN, SecretArnList: [SECRET_ARN] }));
    const unprocessed = res.UnprocessedScramSecrets || [];
    if (unprocessed.length === 0 && await isAssociated()) {
      console.log("secret associated cleanly on attempt " + attempt);
      return { PhysicalResourceId: "MskScramAssoc-" + process.env.SECRET_ARN };
    }
    console.log("attempt " + attempt + " unprocessed=" + JSON.stringify(unprocessed) + " — retrying");
    await sleep(15000);
  }
  throw new Error("Failed to associate SCRAM secret " + SECRET_ARN + " with cluster after " + MAX + " attempts");
};
      `),
      environment: {
        CLUSTER_ARN: mskClusterArn,
        SECRET_ARN: mskCredSecret.secretArn,
      },
    });
    mskAssociateScramLambda.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "kafka:BatchAssociateScramSecret",
        "kafka:BatchDisassociateScramSecret",
        "kafka:ListScramSecrets",
      ],
      resources: [mskClusterArn],
    }));
    // MSK's BatchAssociateScramSecret creates a KMS grant on the secret's CMK (so
    // the broker can decrypt the SCRAM credential) AS THE CALLING PRINCIPAL — the
    // caller must therefore hold kms:CreateGrant on that key, or the association
    // comes back in UnprocessedScramSecrets with
    // "InvalidSecretArn: You are not authorized to invoke the CreateGrant
    // operation on the KMS key". Without this the custom resource retries 8× and
    // fails the deploy. (Previously masked because SCRAM was associated manually
    // via the admin role's kms:* — an automated clean-slot deploy exposes it.)
    mskAssociateScramLambda.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["kms:CreateGrant", "kms:DescribeKey"],
      resources: [mskScramKeyArn],
    }));

    const mskAssociateScramProvider = new Provider(this, "MskAssociateScramProvider", {
      onEventHandler: mskAssociateScramLambda,
    });
    const mskAssociateScram = new CustomResource(this, "MskAssociateScram", {
      serviceToken: mskAssociateScramProvider.serviceToken,
      properties: {
        // Force the resource to re-run whenever the secret ARN changes.
        SecretArn: mskCredSecret.secretArn,
      },
    });
    mskAssociateScram.node.addDependency(mskCredSecret);

    // ── IoT Rule → MSK (Session 4 — native Apache Kafka rule action) ──────────
    // IoT Kafka action writes to the shared MSK cluster via SASL/SCRAM.
    // The SQL stamps deployment_id so the Firehose Iceberg sink can partition by it.
    // Per-slot role for IoT kafka action — needs SCRAM secret + KMS access so IoT can
    // call get_secret() inline. EC2 VPC networking lives on the platform-stack's shared
    // IotVpcDestRole (the VPC destination is shared; only one allowed per VPC).
    const iotKafkaVpcRole = new Role(this, "IotKafkaVpcRole", {
      assumedBy: new ServicePrincipal("iot.amazonaws.com"),
    });

    iotKafkaVpcRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
      resources: [mskCredSecret.secretArn],
    }));

    iotKafkaVpcRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["kms:Decrypt"],
      resources: [mskScramKeyArn],
    }));

    // Allow IoT to write delivery errors to the shared S3 bucket for debugging.
    iotKafkaVpcRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["s3:PutObject"],
      resources: [`${sharedBucketArn}/iot-errors/${deploymentId}/*`],
    }));

    new CfnTopicRule(this, "IotToMskRule", {
      ruleName: `workshop_${deploymentId.replace(/-/g, "_")}_to_msk`,
      topicRulePayload: {
        // Stamps deployment_id and extracts thing_name from the topic path (reliable even if
        // payload omits it). Topic structure: edge/{deploymentId}/{thingName}/telemetry
        sql: `SELECT *, topic(3) AS thing_name, topic() AS mqtt_topic, timestamp() AS ingest_ts, '${deploymentId}' AS deployment_id FROM 'edge/${deploymentId}/+/telemetry'`,
        actions: [
          {
            kafka: {
              destinationArn: iotVpcDestArn,
              topic: "raw.telemetry",
              clientProperties: {
                "bootstrap.servers": mskBootstrapScram,
                "security.protocol": "SASL_SSL",
                "sasl.mechanism": "SCRAM-SHA-512",
                "sasl.scram.username": `\${get_secret('AmazonMSK_workshop-${deploymentId}', 'SecretString', 'username', '${iotKafkaVpcRole.roleArn}')}`,
                "sasl.scram.password": `\${get_secret('AmazonMSK_workshop-${deploymentId}', 'SecretString', 'password', '${iotKafkaVpcRole.roleArn}')}`,
                "acks": "1",
              },
            },
          },
        ],
        // Errors written to S3 for debugging — inspect at s3://…/iot-errors/<deploymentId>/
        errorAction: {
          s3: {
            bucketName: sharedBucketName,
            key: `iot-errors/${deploymentId}/\${timestamp()}/\${newuuid()}`,
            roleArn: iotKafkaVpcRole.roleArn,
            cannedAcl: "private",
          },
        },
        ruleDisabled: false,
      },
    });

    // ── IoT Rule → Firehose → Iceberg (direct hydration path) ────────────────
    // Native Firehose rule action delivers telemetry straight into the shared
    // `workshop-telemetry-iceberg-direct` delivery stream, which lands in the Glue
    // Iceberg table — no MSK hop. Replaces the old MSK→Firehose path; the
    // IotToMskRule above stays because TimescaleDB still consumes from MSK.
    const iotFirehoseRole = new Role(this, "IotFirehoseRole", {
      assumedBy: new ServicePrincipal("iot.amazonaws.com"),
    });
    iotFirehoseRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["firehose:PutRecord", "firehose:PutRecordBatch"],
      resources: [`arn:aws:firehose:${this.region}:${this.account}:deliverystream/workshop-telemetry-iceberg-direct`],
    }));
    // Allow IoT to write delivery errors to the shared S3 bucket for debugging.
    iotFirehoseRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["s3:PutObject"],
      resources: [`${sharedBucketArn}/iot-errors/${deploymentId}/*`],
    }));

    new CfnTopicRule(this, "IotToFirehoseRule", {
      ruleName: `workshop_${deploymentId.replace(/-/g, "_")}_to_firehose`,
      topicRulePayload: {
        // parse_time() requires SQL version 2016-03-23 or later; on the default
        // 2015-10-08 it's unrecognized and silently returns null (which is why
        // year/month/day/hour landed as null partitions). Pin the version.
        awsIotSqlVersion: "2016-03-23",
        // Same enrichment as IotToMskRule so Iceberg columns populate identically,
        // plus year/month/day/hour derived from the ingest time. The Iceberg table
        // partitions on deployment_id + year/month/day/hour as identity columns, so
        // these must be emitted as actual record fields — otherwise every row lands
        // in the literal year=null/month=null/day=null/hour=null partition (UTC).
        sql: `SELECT *, topic(3) AS thing_name, topic() AS mqtt_topic, timestamp() AS ingest_ts, '${deploymentId}' AS deployment_id, parse_time('yyyy', timestamp(), 'UTC') AS year, parse_time('MM', timestamp(), 'UTC') AS month, parse_time('dd', timestamp(), 'UTC') AS day, parse_time('HH', timestamp(), 'UTC') AS hour FROM 'edge/${deploymentId}/+/telemetry'`,
        actions: [
          {
            firehose: {
              deliveryStreamName: "workshop-telemetry-iceberg-direct",
              roleArn: iotFirehoseRole.roleArn,
              // One JSON record per message (no delimiter) — Firehose Iceberg parses each record.
              batchMode: false,
            },
          },
        ],
        errorAction: {
          s3: {
            bucketName: sharedBucketName,
            key: `iot-errors/${deploymentId}/firehose/\${timestamp()}/\${newuuid()}`,
            roleArn: iotFirehoseRole.roleArn,
            cannedAcl: "private",
          },
        },
        ruleDisabled: false,
      },
    });

    // ── Participant IAM role + namespace-scoped EKS access ──────────────────
    // Lets AWS IAM be the thing that decides who can run kubectl/helm in this
    // slot's namespace: whoever the account admin grants sts:AssumeRole on
    // this role's ARN gets in, and revoking that grant removes access — no
    // `aws eks create-access-entry` call needed per participant, no facilitator
    // script to run per attendee. The access entry itself is namespace-scoped
    // (AmazonEKSEditPolicy), so a participant can never see another slot's
    // namespace or touch the cluster-scoped operators installed by the
    // cluster-scoped admin access entries in WorkshopPlatformStack.
    const participantRoleTrustedPrincipals = (props.participantRoleTrustedPrincipalArns?.length
      ? props.participantRoleTrustedPrincipalArns.map((arn) => new ArnPrincipal(arn))
      : [new AccountPrincipal(this.account)]);

    const participantRole = new Role(this, "ParticipantRole", {
      roleName: `WorkshopParticipantRole-${deploymentId}`,
      description: `Assumed by ${deploymentId} participants to run kubectl/helm against their namespace on workshop-eks`,
      assumedBy: new CompositePrincipal(...participantRoleTrustedPrincipals),
    });

    // eks:DescribeCluster is needed for `aws eks update-kubeconfig`; the actual
    // Kubernetes RBAC authorization comes from the access entry below, not IAM.
    participantRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["eks:DescribeCluster"],
      resources: [`arn:aws:eks:${this.region}:${this.account}:cluster/workshop-eks`],
    }));

    const participantAccessEntry = new CfnAccessEntry(this, "ParticipantEksAccessEntry", {
      clusterName: "workshop-eks",
      principalArn: participantRole.roleArn,
      type: "STANDARD",
      accessPolicies: [
        {
          policyArn: "arn:aws:eks::aws:cluster-access-policy/AmazonEKSEditPolicy",
          accessScope: { type: "namespace", namespaces: [deploymentId] },
        },
      ],
    });
    participantAccessEntry.node.addDependency(participantRole);

    // ── Participant IAM policy — non-EKS workshop CLI actions ────────────────
    // `WorkshopParticipantRole` is the participant's full identity (#123,
    // Model 2): every AWS-CLI command a non-admin workshop doc runs must work
    // under this role without an AccessDenied. Scoped to this slot's own
    // resources wherever the API's IAM resource type supports it; a handful
    // of actions have no resource-level permissions at all (noted inline) and
    // fall back to `*`.

    // IoT — grant the whole `iot:*` action namespace, account-wide.
    //
    // The workshop's IoT surface spans control-plane calls (CreateJob against
    // both a job/* ARN *and* its thing-group target; DescribeJob; ListPackages,
    // which has no resource type; SearchIndex against the shared account-wide
    // AWS_Things index; UpdateIndexingConfiguration, an account-wide setting)
    // AND Device Shadow *data-plane* calls (GetThingShadow/UpdateThingShadow —
    // the `aws iot-data` CLI, which IAM authorizes under the `iot:` prefix, NOT
    // `iot-data:`). Per-action scoping here proved both fragile and unsound:
    //   - thing names are EC2 instance IDs / SSH-registered names (not
    //     slot-prefixed) and things carry no tags, so shadow/DescribeThing
    //     can't be scoped tighter than thing/* anyway;
    //   - the shared AWS_Things index and account-wide settings force `*`;
    //   - an earlier attempt used the invalid `iot-data:` IAM prefix for the
    //     shadow actions, which authorizes NOTHING — every shadow call failed
    //     `ForbiddenException` while looking correct in the policy.
    // Since the achievable scoping is already `thing/*` + `*` for most of the
    // IoT surface, a single `iot:*` grant is both simpler and no broader in
    // practice (the workshop account is single-tenant per slot for IoT — thing
    // isolation is enforced by the `attributes.deploymentId:...` fleet-index
    // filter the docs use, not by IAM). #123.
    participantRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["iot:*"],
      resources: ["*"],
    }));

    // S3 — this slot's own job-script/job-doc upload prefixes and telemetry
    // read paths (01-observe/block-2, 02-control/block-2, 03-state/block-2,
    // 05-edge-infra/block-2).
    const slotS3Prefixes = [
      `job-scripts/${deploymentId}/*`,
      `${deploymentId}/job-docs/*`,
      `telemetry/edge/${deploymentId}/*`,
      `telemetry/deployment_id=${deploymentId}/*`,
    ];
    participantRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["s3:PutObject", "s3:GetObject"],
      resources: slotS3Prefixes.map((prefix) => `${sharedBucketArn}/${prefix}`),
    }));
    // Read-only access to the shared Firehose→Iceberg telemetry table. Unlike
    // the slot-owned prefixes above, this table (Glue location `telemetry/`)
    // co-mingles *every* slot's rows in shared data files — Firehose writes
    // it, participants only read it, and per-slot isolation is logical (the
    // doc queries carry `WHERE deployment_id=<slot>`), not physical
    // per-prefix. So the read grant must cover the whole table prefix
    // (metadata JSON + Avro manifests + Parquet data), not a per-slot
    // subpath. Without it, Athena's StartQueryExecution succeeds but the query
    // itself FAILS at scan time with `PERMISSION_DENIED: s3:GetObject on
    // .../telemetry/metadata/*.metadata.json` — surfacing only as
    // `GetQueryResults: Query did not finish successfully` (01-observe/
    // block-3-athena block 2, 02-control/block-5-observe block 1).
    const icebergTablePrefix = "telemetry/*";
    participantRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["s3:GetObject"],
      resources: [`${sharedBucketArn}/${icebergTablePrefix}`],
    }));
    participantRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["s3:ListBucket"],
      resources: [sharedBucketArn],
      conditions: {
        StringLike: {
          "s3:prefix": [...slotS3Prefixes, icebergTablePrefix, "athena-results/*"],
        },
      },
    }));

    // Athena's query-results location is a single shared prefix, not
    // slot-partitioned (see the workgroup's outputLocation in
    // platform-stack.ts) — every participant's queries land under the same
    // athena-results/ prefix, so object-level access can't be scoped tighter
    // than the whole prefix.
    participantRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["s3:PutObject", "s3:GetObject"],
      resources: [`${sharedBucketArn}/athena-results/*`],
    }));

    // Before running a query, Athena verifies its output bucket exists by
    // calling s3:GetBucketLocation on the *bucket* (not a prefix) — without
    // this the StartQueryExecution above fails
    // `InvalidRequestException: Unable to verify/create output bucket`
    // (01-observe/block-3-athena, 02-control/block-5-observe). The role's only
    // other GetBucketLocation grant is on its RisingWave bucket, so it must be
    // granted explicitly on the shared platform bucket here. Bucket-level,
    // unconditioned — GetBucketLocation takes no prefix.
    participantRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["s3:GetBucketLocation"],
      resources: [sharedBucketArn],
    }));

    // This slot's own RisingWave state bucket, created by the participant in
    // 04-analytics/block-1-deploy.md Step 5 — bucket-level actions only, no
    // object path to scope further.
    participantRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["s3:CreateBucket", "s3:ListBucket", "s3:GetBucketLocation"],
      resources: [`arn:aws:s3:::workshop-${deploymentId}-${this.account}-risingwave-state`],
    }));

    // Secrets Manager — this slot's own claim cert and MSK SASL/SCRAM creds.
    claimSecret.grantRead(participantRole);
    mskCredSecret.grantRead(participantRole);

    // grantRead() only adds secretsmanager:GetSecretValue/DescribeSecret —
    // the SCRAM secret is KMS-encrypted with an imported key (mskScramKey,
    // via KmsKey.fromKeyArn above), so CDK can't add an identity-policy
    // decrypt grant automatically. Mirrors iotKafkaVpcRole's grant on the
    // same key/secret above.
    participantRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["kms:Decrypt"],
      resources: [mskScramKeyArn],
    }));

    // SSM Parameter Store — this slot's own namespace (kubeconfig, etc — see
    // 04-analytics/block-1, 05-edge-infra/block-3, 05-edge-infra/block-4).
    participantRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/workshop/${deploymentId}/*`],
    }));

    // SSM Session Manager port-forwarding / run-command — scoped to this
    // slot's own EC2 instances via the WorkshopDeploymentId tag every
    // EdgeInstance/SensorSimulatorInstance carries (see the CfnInstance
    // definitions above), not to a specific instance ID (unknown at synth
    // time and re-created on every deploy).
    participantRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["ssm:StartSession", "ssm:SendCommand"],
      resources: [`arn:aws:ec2:${this.region}:${this.account}:instance/*`],
      conditions: {
        StringEquals: { "aws:ResourceTag/WorkshopDeploymentId": deploymentId },
      },
    }));
    // ssm:SendCommand and ssm:StartSession both also need permission on the
    // SSM document resource itself — AWS-owned public documents, not
    // per-slot resources, so they can't be scoped any tighter than the
    // document ARN (empty account segment). AWS-RunShellScript backs
    // SendCommand (register-device-over-ssh.md); AWS-StartPortForwardingSession
    // backs the K3s port-forward tunnel (05-edge-infra/block-3, block-4) and
    // AWS-StartSSHSession backs the SSH-over-SSM jump (register-device-over-
    // ssh.md) — both via start-session.
    participantRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["ssm:SendCommand"],
      resources: [`arn:aws:ssm:${this.region}::document/AWS-RunShellScript`],
    }));
    participantRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["ssm:StartSession"],
      resources: [
        `arn:aws:ssm:${this.region}::document/AWS-StartPortForwardingSession`,
        `arn:aws:ssm:${this.region}::document/AWS-StartSSHSession`,
      ],
    }));
    // ssm:GetCommandInvocation and ssm:DescribeInstanceInformation do not
    // support resource-level permissions (AWS Service Authorization
    // Reference lists only `*` for these actions).
    participantRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["ssm:GetCommandInvocation", "ssm:DescribeInstanceInformation"],
      resources: ["*"],
    }));

    // CloudFormation — cloudformation:ListExports has no resource type at
    // all; cloudformation:DescribeStacks technically supports a stack ARN,
    // but every documented call filters `Exports[?Name==...]` without
    // knowing the stack name up front, so neither can be scoped tighter than
    // the whole account/region (04-analytics/block-1, block-2; 05-edge-infra/
    // block-3).
    participantRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["cloudformation:ListExports", "cloudformation:DescribeStacks"],
      resources: ["*"],
    }));

    // MSK — bootstrap-broker lookup for the shared cluster (04-analytics/
    // block-1, block-2; 05-edge-infra/block-3).
    participantRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["kafka:GetBootstrapBrokers"],
      resources: [mskClusterArn],
    }));

    // Athena — the single shared workgroup all slots query through
    // (01-observe/block-3, 02-control/block-5).
    participantRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults"],
      resources: [`arn:aws:athena:${this.region}:${this.account}:workgroup/workshop-shared`],
    }));

    // Glue Data Catalog — read-only access to the shared telemetry database
    // that both `aws glue get-tables` and every Athena SELECT need (same
    // scoping as WorkshopPlatformStack's Flink role).
    participantRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["glue:GetDatabase", "glue:GetTable", "glue:GetTables", "glue:GetPartition", "glue:GetPartitions"],
      resources: [
        `arn:aws:glue:${this.region}:${this.account}:catalog`,
        `arn:aws:glue:${this.region}:${this.account}:database/workshop_telemetry`,
        `arn:aws:glue:${this.region}:${this.account}:table/workshop_telemetry/*`,
      ],
    }));

    // EC2 — describe-only calls have no resource-level permissions support
    // (05-edge-infra/block-2, block-3).
    participantRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["ec2:DescribeInstances"],
      resources: ["*"],
    }));

    // ── Outputs ──────────────────────────────────────────────────────────────
    new CfnOutput(this, "DeploymentId", {
      exportName: `workshop-${deploymentId}-deployment-id`,
      value: deploymentId,
    });

    new CfnOutput(this, "ClaimSecretArn", {
      exportName: `workshop-${deploymentId}-claim-secret`,
      value: claimSecret.secretArn,
    });

    new CfnOutput(this, "EksClusterName", {
      exportName: `workshop-${deploymentId}-eks-cluster`,
      value: "workshop-eks",
      description: "Shared EKS cluster. Run: aws eks update-kubeconfig --name workshop-eks",
    });

    new CfnOutput(this, "ParticipantRoleArn", {
      exportName: `workshop-${deploymentId}-participant-role`,
      value: participantRole.roleArn,
      description: `Assume this role for kubectl/helm access to namespace ${deploymentId} on workshop-eks`,
    });

    new CfnOutput(this, "MskCredSecretArn", {
      exportName: `workshop-${deploymentId}-msk-cred-secret`,
      value: mskCredSecret.secretArn,
    });

    new CfnOutput(this, "SharedBucketName", {
      exportName: `workshop-${deploymentId}-shared-bucket`,
      value: sharedBucketName,
      description: "Shared S3 bucket — your Iceberg data is at telemetry/deployment_id=<your-id>/",
    });

    // ── SSM parameters ──────────────────────────────────────────────────────
    // Published under a stable path so the e2e/doc-runner tests can resolve
    // everything they need for a deployment slot with only the deployment ID —
    // no local amplify_outputs.json or synthesized CDK app required.
    new StringParameter(this, "DeploymentIdSsmParam", {
      parameterName: `/workshop/${deploymentId}/deployment-id`,
      stringValue: deploymentId,
    });

    new StringParameter(this, "ClaimSecretArnSsmParam", {
      parameterName: `/workshop/${deploymentId}/claim-secret-arn`,
      stringValue: claimSecret.secretArn,
    });

    new StringParameter(this, "EksClusterNameSsmParam", {
      parameterName: `/workshop/${deploymentId}/eks-cluster-name`,
      stringValue: "workshop-eks",
    });

    new StringParameter(this, "ParticipantRoleArnSsmParam", {
      parameterName: `/workshop/${deploymentId}/participant-role-arn`,
      stringValue: participantRole.roleArn,
    });

    new StringParameter(this, "MskCredSecretArnSsmParam", {
      parameterName: `/workshop/${deploymentId}/msk-cred-secret-arn`,
      stringValue: mskCredSecret.secretArn,
    });

    new StringParameter(this, "SharedBucketNameSsmParam", {
      parameterName: `/workshop/${deploymentId}/shared-bucket-name`,
      stringValue: sharedBucketName,
    });
  }
}
