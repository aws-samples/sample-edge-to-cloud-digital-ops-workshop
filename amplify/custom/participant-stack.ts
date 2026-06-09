import { Stack, StackProps, RemovalPolicy, Duration, CfnOutput, Fn, CfnDeletionPolicy } from "aws-cdk-lib";
import {
  Vpc,
  SubnetType,
  SecurityGroup,
  Peer,
  Port,
  CfnInstance,
  MachineImage,
  CfnInternetGateway,
  CfnVPCGatewayAttachment,
  CfnSubnet,
  CfnRouteTable,
  CfnRoute,
  CfnSubnetRouteTableAssociation,
  CfnSecurityGroup,
} from "aws-cdk-lib/aws-ec2";
import {
  Role,
  ServicePrincipal,
  ManagedPolicy,
  PolicyStatement,
  Effect,
  CfnInstanceProfile,
} from "aws-cdk-lib/aws-iam";
import {
  CfnProvisioningTemplate,
  CfnPolicy as IotPolicy,
  CfnThingGroup,
  CfnSoftwarePackage,
  CfnSoftwarePackageVersion,
} from "aws-cdk-lib/aws-iot";
import {
  Secret,
} from "aws-cdk-lib/aws-secretsmanager";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from "aws-cdk-lib/custom-resources";
import {
  CfnCluster as MskCluster,
} from "aws-cdk-lib/aws-msk";
import {
  CfnCluster as EksCfnCluster,
  CfnNodegroup,
} from "aws-cdk-lib/aws-eks";
import {
  Bucket,
  BlockPublicAccess,
  BucketEncryption,
} from "aws-cdk-lib/aws-s3";
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
  CfnApi as CfnAppSyncApi,
  CfnChannelNamespace,
} from "aws-cdk-lib/aws-appsync";
import {
  CfnWorkGroup,
} from "aws-cdk-lib/aws-athena";
import {
  CfnDatabase,
  CfnTable,
} from "aws-cdk-lib/aws-glue";
import { Construct } from "constructs";

export interface ParticipantStackProps extends StackProps {
  deploymentId: string;
}

/**
 * All resources scoped to a single workshop slot (deploymentId).
 *
 * Deployed resources:
 *  - Edge subnet (/24) in workshop-edge VPC, network-isolated (IGW-only route table)
 *  - 3× t3.medium EC2 instances with IoT Device Client, fleet provisioning by claim
 *  - IoT Provisioning Template + claim cert (stored in Secrets Manager)
 *  - Pre-provisioning hook Lambda
 *  - IoT Dynamic Thing Group
 *  - IoT Rule → MSK (raw.telemetry topic)
 *  - MSK Provisioned cluster (kafka.t3.small × 2 brokers, SASL/SCRAM)
 *  - IoT Rule → Lambda → MSK (raw.telemetry topic, Session 4)
 *  - S3 bucket + Athena workgroup + Glue telemetry table (Sessions 1–3)
 *  - EKS cluster (t3.medium × 2 nodes, workshop-cloud VPC, Session 4)
 */
export class ParticipantStack extends Stack {
  constructor(scope: Construct, id: string, props: ParticipantStackProps) {
    super(scope, id, props);

    const { deploymentId } = props;

    const edgeVpc = Vpc.fromLookup(this, "WorkshopEdgeVpc", { vpcName: "workshop-edge" });
    const cloudVpc = Vpc.fromLookup(this, "WorkshopCloudVpc", { vpcName: "workshop-cloud" });

    // ── S3 ──────────────────────────────────────────────────────────────────
    const workshopBucket = new Bucket(this, "WorkshopBucket", {
      bucketName: `workshop-${deploymentId}`,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      versioned: false,
    });

    // ── Athena workgroup ─────────────────────────────────────────────────────
    new CfnWorkGroup(this, "AthenaWorkGroup", {
      name: `workshop-${deploymentId}`,
      workGroupConfiguration: {
        engineVersion: {
          selectedEngineVersion: "Athena engine version 3",
        },
        resultConfiguration: {
          outputLocation: `s3://${workshopBucket.bucketName}/athena-results/`,
        },
        publishCloudWatchMetricsEnabled: false,
      },
    });

    // ── Glue database + telemetry table (queried by Athena) ──────────────────
    // Glue DB name uses underscores (Athena identifier rules).
    const glueDbName = `workshop_${deploymentId.replace(/-/g, "_")}`;
    const glueDb = new CfnDatabase(this, "GlueDatabase", {
      catalogId: this.account,
      databaseInput: {
        name: glueDbName,
        description: `Workshop telemetry database for ${deploymentId}`,
      },
    });

    // Pre-create the Glue table so Athena queries work as soon as telemetry arrives.
    // Schema matches the IoT Rule SQL: SELECT *, topic() AS mqtt_topic, timestamp() AS ingest_ts
    new CfnTable(this, "GlueTelemetryTable", {
      catalogId: this.account,
      databaseName: glueDbName,
      tableInput: {
        name: "telemetry",
        tableType: "EXTERNAL_TABLE",
        parameters: {
          "classification": "json",
          "has_encrypted_data": "false",
        },
        storageDescriptor: {
          location: `s3://${workshopBucket.bucketName}/telemetry/`,
          inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
          outputFormat: "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
          serdeInfo: {
            serializationLibrary: "org.openx.data.jsonserde.JsonSerDe",
            parameters: { "serialization.format": "1" },
          },
          columns: [
            { name: "thing_name", type: "string" },
            { name: "cpu_pct", type: "double" },
            { name: "mem_used_pct", type: "double" },
            { name: "disk_used_pct", type: "double" },
            { name: "net_io_bytes_sent", type: "bigint" },
            { name: "net_io_bytes_recv", type: "bigint" },
            { name: "message_timestamp", type: "bigint" },
            { name: "mqtt_topic", type: "string" },
            { name: "ingest_ts", type: "bigint" },
          ],
        },
      },
    }).addDependency(glueDb);

    // ── IAM roles ────────────────────────────────────────────────────────────
    // EC2 instance profile
    const ec2Role = new Role(this, "EdgeEc2Role", {
      assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });

    // Allow EC2 instances to read the claim secret (narrow to this deployment)
    const claimSecret = new Secret(this, "ClaimCertSecret", {
      secretName: `/workshop/${deploymentId}/claim-cert`,
      description: `IoT fleet provisioning claim cert for ${deploymentId}`,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    claimSecret.grantRead(ec2Role);

    // Create the IoT claim certificate and populate the secret.
    // CreateKeysAndCertificate returns the cert + private key only at creation time,
    // so we use AwsCustomResource to call it once and store the result in Secrets Manager.
    // onDelete intentionally omitted — teardown.sh deactivates and deletes the cert.
    // Omitting onDelete avoids a self-referential initializer (cert ID not yet available).
    const createClaimCert = new AwsCustomResource(this, "CreateClaimCert", {
      onCreate: {
        service: "IoT",
        action: "createKeysAndCertificate",
        parameters: { setAsActive: true },
        physicalResourceId: PhysicalResourceId.fromResponse("certificateId"),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: AwsCustomResourcePolicy.ANY_RESOURCE }),
    });

    // Attach the claim policy to the newly created certificate
    new AwsCustomResource(this, "AttachClaimPolicy", {
      onCreate: {
        service: "IoT",
        action: "attachPolicy",
        parameters: {
          policyName: `workshop-${deploymentId}-claim-policy`,
          target: createClaimCert.getResponseField("certificateArn"),
        },
        physicalResourceId: PhysicalResourceId.of("attach-claim-policy"),
      },
      onDelete: {
        service: "IoT",
        action: "detachPolicy",
        parameters: {
          policyName: `workshop-${deploymentId}-claim-policy`,
          target: createClaimCert.getResponseField("certificateArn"),
        },
        ignoreErrorCodesMatching: "ResourceNotFoundException",
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: AwsCustomResourcePolicy.ANY_RESOURCE }),
    });

    // Write the cert + key JSON into the secret so EC2 user data can retrieve it
    new AwsCustomResource(this, "PopulateClaimSecret", {
      onCreate: {
        service: "SecretsManager",
        action: "putSecretValue",
        parameters: {
          SecretId: claimSecret.secretArn,
          SecretString: JSON.stringify({
            certificate: createClaimCert.getResponseField("certificatePem"),
            privateKey: createClaimCert.getResponseField("keyPair.PrivateKey"),
            certificateArn: createClaimCert.getResponseField("certificateArn"),
            certificateId: createClaimCert.getResponseField("certificateId"),
          }),
        },
        physicalResourceId: PhysicalResourceId.of("populate-claim-secret"),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: [claimSecret.secretArn] }),
    });

    // Allow Device Client to look up the IoT data endpoint and perform MQTT/shadow/jobs operations
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

    ec2Role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["s3:PutObject", "s3:GetObject"],
        resources: [
          `${workshopBucket.bucketArn}/job-scripts/*`,
          `${workshopBucket.bucketArn}/bin/*`,
          `${workshopBucket.bucketArn}/simulator/*`,
        ],
      })
    );

    // K3s install job writes token + kubeconfig to SSM Parameter Store;
    // agents read them back. Scoped to /workshop/<deploymentId>/.
    ec2Role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["ssm:PutParameter", "ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/workshop/${deploymentId}/*`,
        ],
      })
    );

    // deploy-k3s.sh uses ListThingsInThingGroup to determine server/agent role
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
    const preProvisionLambdaRole = new Role(this, "PreProvisionLambdaRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
    });

    preProvisionLambdaRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["iot:DescribeThing"],
        resources: ["*"],
      })
    );

    preProvisionLambdaRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["ec2:DescribeInstances"],
        resources: ["*"],
      })
    );

    // --8<-- [start:pre-provision-hook]
    const preProvisionLambda = new LambdaFn(this, "PreProvisionHook", {
      functionName: `workshop-${deploymentId}-pre-provision`,
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      handler: "index.handler",
      code: Code.fromInline(`
const { IoTClient, DescribeThingCommand } = require("@aws-sdk/client-iot");
const { EC2Client, DescribeInstancesCommand } = require("@aws-sdk/client-ec2");

const iot = new IoTClient({});
const ec2 = new EC2Client({});
const DEPLOYMENT_ID = "${deploymentId}";

exports.handler = async (event) => {
  const thingName = event.parameters?.ThingName;
  if (!thingName) return { allowProvisioning: false };

  // Reject if Thing already exists (prevent duplicate registration)
  try {
    await iot.send(new DescribeThingCommand({ thingName }));
    console.log("Thing already exists, rejecting:", thingName);
    return { allowProvisioning: false };
  } catch (err) {
    if (err.name !== "ResourceNotFoundException") throw err;
  }

  // Verify the requesting instance ID exists in EC2 and has the deployment tag
  const result = await ec2.send(new DescribeInstancesCommand({
    Filters: [
      { Name: "instance-id", Values: [thingName] },
      { Name: "tag:WorkshopDeploymentId", Values: [DEPLOYMENT_ID] },
    ],
  }));

  const instances = result.Reservations?.flatMap(r => r.Instances ?? []) ?? [];
  if (instances.length === 0) {
    console.log("No matching EC2 instance for", thingName, "in deployment", DEPLOYMENT_ID);
    return { allowProvisioning: false };
  }

  return { allowProvisioning: true };
};
      `),
      role: preProvisionLambdaRole,
      timeout: Duration.seconds(10),
    });

    // Grant IoT Core permission to invoke the hook
    preProvisionLambda.addPermission("AllowIoTInvoke", {
      principal: new ServicePrincipal("iot.amazonaws.com"),
    });
    // --8<-- [end:pre-provision-hook]

    // ── IoT Provisioning Template ────────────────────────────────────────────
    const provisioningRole = new Role(this, "ProvisioningRole", {
      assumedBy: new ServicePrincipal("iot.amazonaws.com"),
      // AWSIoTThingsRegistration is required for RegisterThing to succeed
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSIoTThingsRegistration"),
      ],
    });

    // Thing group that every provisioned device joins — IoT Job targets this group
    new CfnThingGroup(this, "DevicesThingGroup", {
      thingGroupName: `${deploymentId}-devices`,
    });

    // ── Software Package Catalog ─────────────────────────────────────────────
    // Registered so fleet indexing can query $package shadow by version.
    // Devices write the $package shadow on boot (v1.0.0) and after the
    // telemetry-v2 job runs (v2.0.0).
    const softwarePackage = new CfnSoftwarePackage(this, "TelemetryAgentPackage", {
      packageName: `${deploymentId}-telemetry-agent`,
    });

    new CfnSoftwarePackageVersion(this, "TelemetryAgentV1", {
      packageName: softwarePackage.ref,
      versionName: "1.0.0",
    });

    new CfnSoftwarePackageVersion(this, "TelemetryAgentV2", {
      packageName: softwarePackage.ref,
      versionName: "2.0.0",
    });

    // --8<-- [start:provisioning-template]
    new CfnProvisioningTemplate(this, "ProvisioningTemplate", {
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
    // --8<-- [end:provisioning-template]

    // ── Edge subnet (network-isolated /24) ───────────────────────────────────
    // We pick a /24 slot based on the numeric slot index embedded in deploymentId.
    // e.g. ws-slot00 → 10.0.0.0/24, ws-slot01 → 10.0.1.0/24, etc.
    const slotIndex = parseInt(deploymentId.replace(/\D/g, "").slice(-2), 10) || 0;
    const edgeSubnetCidr = `10.0.${slotIndex}.0/24`;

    // Use L1 constructs because the edge VPC was created with no subnet config.
    const edgeSubnet = new CfnSubnet(this, "EdgeSubnet", {
      vpcId: edgeVpc.vpcId,
      cidrBlock: edgeSubnetCidr,
      availabilityZone: `${this.region}a`,
      mapPublicIpOnLaunch: true,
      tags: [{ key: "Name", value: `workshop-edge-${deploymentId}` }],
    });

    // Route table: only the IGW route — no route to other subnets.
    const edgeRtb = new CfnRouteTable(this, "EdgeRtb", {
      vpcId: edgeVpc.vpcId,
      tags: [{ key: "Name", value: `workshop-edge-${deploymentId}-rtb` }],
    });

    // Find or reference the IGW already attached to the edge VPC.
    // The edge VPC was created without subnets so CDK did not auto-attach an IGW.
    // We attach one here if needed.
    const igw = new CfnInternetGateway(this, "EdgeIgw", {
      tags: [{ key: "Name", value: `workshop-edge-${deploymentId}-igw` }],
    });

    new CfnVPCGatewayAttachment(this, "EdgeIgwAttach", {
      vpcId: edgeVpc.vpcId,
      internetGatewayId: igw.ref,
    });

    new CfnRoute(this, "EdgeDefaultRoute", {
      routeTableId: edgeRtb.ref,
      destinationCidrBlock: "0.0.0.0/0",
      gatewayId: igw.ref,
    });

    new CfnSubnetRouteTableAssociation(this, "EdgeSubnetRtbAssoc", {
      subnetId: edgeSubnet.ref,
      routeTableId: edgeRtb.ref,
    });

    // Security group: intra-VPC all traffic (K3s cluster + MQTT broker) + outbound internet
    const edgeSg = new CfnSecurityGroup(this, "EdgeSg", {
      vpcId: edgeVpc.vpcId,
      groupDescription: `workshop-edge-${deploymentId}`,
      securityGroupIngress: [
        // Allow all traffic within the edge VPC subnet (K3s API, MQTT broker, Redpanda, RisingWave)
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

# Install SSM Agent (pre-installed on Amazon Linux 2023, but ensure it's running)
yum install -y amazon-ssm-agent 2>/dev/null || true
systemctl enable amazon-ssm-agent && systemctl start amazon-ssm-agent

INSTANCE_ID=$(ec2-metadata --instance-id | cut -d' ' -f2)

# Retrieve claim cert from Secrets Manager (no hardcoded secrets in user data)
mkdir -p /etc/aws-iot-device-client/certs
SECRET_JSON=$(aws secretsmanager get-secret-value \
  --region ${this.region} \
  --secret-id /workshop/${deploymentId}/claim-cert \
  --query SecretString --output text)

echo "$SECRET_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); open('/etc/aws-iot-device-client/certs/claim.pem.crt','w').write(d['certificate']); open('/etc/aws-iot-device-client/certs/claim-private.pem.key','w').write(d['privateKey'])"
# cert must be 644 (world-readable) — Device Client validates this
chmod 644 /etc/aws-iot-device-client/certs/claim.pem.crt
chmod 600 /etc/aws-iot-device-client/certs/claim-private.pem.key

# Download Amazon Root CA
curl -o /etc/aws-iot-device-client/certs/AmazonRootCA1.pem \
  https://www.amazontrust.com/repository/AmazonRootCA1.pem

# Get IoT Core data endpoint
IOT_ENDPOINT=$(aws iot describe-endpoint \
  --region ${this.region} \
  --endpoint-type iot:Data-ATS \
  --query endpointAddress --output text)

# Download Device Client binary built by sandbox.sh and staged in S3.
# sandbox.sh builds it once using the official GHCR build image and uploads here.
aws s3 cp "s3://workshop-${deploymentId}/bin/aws-iot-device-client" /usr/local/bin/aws-iot-device-client --region ${this.region}
chmod +x /usr/local/bin/aws-iot-device-client

mkdir -p /etc/aws-iot-device-client/jobs
# certs dir must be 700; Device Client rejects cert files outside a 700 directory
chmod 700 /etc/aws-iot-device-client/certs

# Write Device Client config.
# On first boot: cert/key point to claim certs (fleet provisioning not yet run).
# After fleet provisioning completes, Device Client writes a runtime config that
# overrides cert/key with the newly-issued device cert for subsequent connections.
# Note: device-key/device-cert/claim-cert/claim-key are NOT recognized fleet-provisioning
# JSON keys — omit them to avoid IsValidFilePath() validation on non-existent files.
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

# Generic IoT Job handler: downloads and runs an S3-hosted script.
# Device Client calls: run-script.sh <runAsUser> <scriptUri> [args...]
# $1 = runAsUser (empty string if not set), $2 = S3 URI of script to execute
cat > /etc/aws-iot-device-client/jobs/run-script.sh <<'HANDLER'
#!/bin/bash
set -euo pipefail
SCRIPT_URI="\${2:-}"
if [[ -z "$SCRIPT_URI" ]]; then
  echo "ERROR: no scriptUri provided as arg" >&2
  exit 1
fi
aws s3 cp "$SCRIPT_URI" /tmp/job-script.sh --region us-east-1
chmod +x /tmp/job-script.sh
/tmp/job-script.sh
HANDLER
chmod +x /etc/aws-iot-device-client/jobs/run-script.sh

# Device Client adds ~/.aws-iot-device-client/jobs to PATH when executing handlers.
# Symlink the configured handler-directory so handlers are found via execvp().
mkdir -p /root/.aws-iot-device-client
ln -sfn /etc/aws-iot-device-client/jobs /root/.aws-iot-device-client/jobs

# Initial telemetry script (v1): publishes at 0.2 Hz with cpu/mem/disk metrics.
# telemetry-v2.sh job overwrites this file and restarts the service.
cat > /etc/aws-iot-device-client/jobs/publish-telemetry.sh <<'TELEMETRY'
#!/bin/bash
INSTANCE_ID=$(ec2-metadata --instance-id | cut -d' ' -f2)
DEPLOYMENT_ID=$DEPLOYMENT_ID
IOT_ENDPOINT=$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text)
INTERVAL_S=5  # 0.2 Hz

while true; do
  TS=$(date -u +%s%3N)
  CPU=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | tr -d '%us,')
  MEM=$(free | awk '/Mem:/ {printf "%.1f", $3/$2*100}')
  DISK=$(df / | awk 'NR==2 {print $5}' | tr -d '%')

  PAYLOAD=$(printf \
    '{"thing_name":"%s","message_timestamp":%s,"cpu_pct":%s,"mem_used_pct":%s,"disk_used_pct":%s}' \
    "$INSTANCE_ID" "$TS" "$CPU" "$MEM" "$DISK")

  aws iot-data publish \
    --endpoint-url "https://$IOT_ENDPOINT" \
    --topic "edge/$DEPLOYMENT_ID/$INSTANCE_ID/telemetry" \
    --payload "$PAYLOAD" \
    --cli-binary-format raw-in-base64-out \
    2>/dev/null || true

  sleep $INTERVAL_S
done
TELEMETRY
chmod +x /etc/aws-iot-device-client/jobs/publish-telemetry.sh

# Systemd unit: workshop-telemetry — replaced in Session 2 by telemetry-v2.sh job
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

# Write deployment ID env file so telemetry script picks it up
echo "DEPLOYMENT_ID=${deploymentId}" > /etc/workshop-telemetry.env

# Systemd unit for Device Client binary
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

systemctl daemon-reload
systemctl enable aws-iot-device-client workshop-telemetry
systemctl start aws-iot-device-client workshop-telemetry
`;

    const amiId = MachineImage.latestAmazonLinux2023().getImage(this).imageId;
    const encodedUserData = Fn.base64(userDataScript);

    const instanceProfile = new CfnInstanceProfile(this, "EdgeInstanceProfile", {
      roles: [ec2Role.roleName],
    });

    for (let i = 0; i < 3; i++) {
      new CfnInstance(this, `EdgeInstance${i}`, {
        instanceType: "t3.medium",
        imageId: amiId,
        subnetId: edgeSubnet.ref,
        securityGroupIds: [edgeSg.ref],
        iamInstanceProfile: instanceProfile.ref,
        userData: encodedUserData,
        tags: [
          { key: "WorkshopDeploymentId", value: deploymentId },
          { key: "Name", value: `workshop-${deploymentId}-edge-${i}` },
        ],
      });
    }

    // ── Sensor Simulator EC2 (Session 5 — Step 5B) ──────────────────────────
    // A 4th EC2 instance running the Python sensor simulator and Mosquitto MQTT broker.
    // Publishes to mosquitto:1883; Redpanda Connect in K3s reads from there.
    const simulatorUserData = `#!/bin/bash
set -euxo pipefail

yum install -y amazon-ssm-agent mosquitto python3-pip 2>/dev/null || true
systemctl enable amazon-ssm-agent && systemctl start amazon-ssm-agent
systemctl enable mosquitto && systemctl start mosquitto

pip3 install paho-mqtt

# Download sensor simulator from S3
aws s3 cp s3://workshop-${deploymentId}/simulator/sensor-sim.py /usr/local/bin/sensor-sim.py --region ${this.region}
chmod +x /usr/local/bin/sensor-sim.py

cat > /etc/systemd/system/sensor-sim.service <<EOF
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
EOF

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

    // ── MSK Provisioned cluster ──────────────────────────────────────────────
    const mskSg = new SecurityGroup(this, "MskSg", {
      vpc: cloudVpc,
      description: `workshop-${deploymentId}-msk`,
      allowAllOutbound: true,
    });

    // Allow IoT Rules Engine (inside VPC destination) to reach MSK on 9096 (SASL/SCRAM)
    mskSg.addIngressRule(
      Peer.ipv4(cloudVpc.vpcCidrBlock),
      Port.tcp(9096),
      "SASL/SCRAM from VPC"
    );

    const mskCluster = new MskCluster(this, "MskCluster", {
      clusterName: `workshop-${deploymentId}-msk`,
      kafkaVersion: "3.6.0",
      numberOfBrokerNodes: 2,
      brokerNodeGroupInfo: {
        instanceType: "kafka.t3.small",
        clientSubnets: cloudVpc.selectSubnets({ subnetType: SubnetType.PRIVATE_WITH_EGRESS }).subnetIds.slice(0, 2),
        securityGroups: [mskSg.securityGroupId],
        storageInfo: {
          ebsStorageInfo: {
            volumeSize: 50,
          },
        },
      },
      clientAuthentication: {
        sasl: {
          scram: {
            enabled: true,
          },
        },
      },
      encryptionInfo: {
        encryptionInTransit: {
          clientBroker: "TLS",
          inCluster: true,
        },
      },
    });
    // MSK takes 15+ min to create and can't be deleted while CREATING, which causes
    // DELETE_FAILED cascades on rollback. Teardown is handled by scripts/teardown.sh.
    mskCluster.cfnOptions.deletionPolicy = CfnDeletionPolicy.RETAIN;

    // ── IoT Rule → S3 (raw telemetry landing) ───────────────────────────────
    // Routes edge/<deploymentId>/+/telemetry messages to S3 for Athena queries.
    // MSK → IoT direct Kafka action requires an IoT VPC Destination (separate setup);
    // S3 action is used here for workshop bootstrap.
    const iotRuleRole = new Role(this, "IotRuleRole", {
      assumedBy: new ServicePrincipal("iot.amazonaws.com"),
    });

    iotRuleRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["s3:PutObject"],
        resources: [`${workshopBucket.bucketArn}/telemetry/*`],
      })
    );

    new CfnTopicRule(this, "IotToS3Rule", {
      ruleName: `workshop_${deploymentId.replace(/-/g, "_")}_to_s3`,
      topicRulePayload: {
        sql: `SELECT *, topic() AS mqtt_topic, timestamp() AS ingest_ts FROM 'edge/${deploymentId}/+/telemetry'`,
        actions: [
          {
            s3: {
              bucketName: workshopBucket.bucketName,
              key: "telemetry/\${topic()}/\${timestamp()}",
              roleArn: iotRuleRole.roleArn,
            },
          },
        ],
        ruleDisabled: false,
      },
    });

    // ── AppSync Events API (live push — no persistence) ──────────────────────
    // Path: device MQTT → IoT Core → IoT Rule → Lambda → AppSync Events → browser WebSocket.
    // IoT's HTTP action requires a pre-confirmed destination URL (not settable via CFN),
    // so a thin Lambda bridge is used instead.
    const eventsApi = new CfnAppSyncApi(this, "TelemetryEventsApi", {
      name: `workshop-${deploymentId}-events`,
      eventConfig: {
        authProviders: [{ authType: "AWS_IAM" }],
        connectionAuthModes: [{ authType: "AWS_IAM" }],
        defaultPublishAuthModes: [{ authType: "AWS_IAM" }],
        defaultSubscribeAuthModes: [{ authType: "AWS_IAM" }],
      },
    });

    // Channel namespace: /telemetry/<deploymentId>/<thingName>
    new CfnChannelNamespace(this, "TelemetryNamespace", {
      apiId: eventsApi.attrApiId,
      name: "telemetry",
    });

    // Lambda bridge: IoT Rule → Lambda → AppSync Events publish
    const appSyncBridgeRole = new Role(this, "AppSyncBridgeRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });

    appSyncBridgeRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["appsync:EventPublish"],
        resources: [`${eventsApi.attrApiArn}/channel/telemetry/*`],
      })
    );

    const appSyncBridgeFn = new LambdaFn(this, "AppSyncBridge", {
      functionName: `workshop-${deploymentId}-appsync-bridge`,
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      handler: "index.handler",
      role: appSyncBridgeRole,
      timeout: Duration.seconds(5),
      environment: {
        APPSYNC_HTTP_ENDPOINT: eventsApi.attrDnsHttp,
        DEPLOYMENT_ID: deploymentId,
        REGION: this.region,
      },
      code: Code.fromAsset("amplify/lambda/appsync-bridge"),
    });

    appSyncBridgeFn.addPermission("AllowIoTInvoke", {
      principal: new ServicePrincipal("iot.amazonaws.com"),
    });

    new CfnTopicRule(this, "IotToAppSyncRule", {
      ruleName: `workshop_${deploymentId.replace(/-/g, "_")}_to_appsync`,
      topicRulePayload: {
        sql: `SELECT * FROM 'edge/${deploymentId}/+/telemetry'`,
        actions: [
          {
            lambda: {
              functionArn: appSyncBridgeFn.functionArn,
            },
          },
        ],
        ruleDisabled: false,
      },
    });

    // ── EKS Cluster (Session 4 — cloud analytics) ────────────────────────────
    // L1 constructs to keep the CDK package footprint minimal.
    const eksClusterRole = new Role(this, "EksClusterRole", {
      assumedBy: new ServicePrincipal("eks.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("AmazonEKSClusterPolicy"),
        ManagedPolicy.fromAwsManagedPolicyName("AmazonEKSVPCResourceController"),
      ],
    });

    const eksNodeRole = new Role(this, "EksNodeRole", {
      assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("AmazonEKSWorkerNodePolicy"),
        ManagedPolicy.fromAwsManagedPolicyName("AmazonEKS_CNI_Policy"),
        ManagedPolicy.fromAwsManagedPolicyName("AmazonEC2ContainerRegistryReadOnly"),
      ],
    });

    const eksSg = new SecurityGroup(this, "EksSg", {
      vpc: cloudVpc,
      description: `workshop-${deploymentId}-eks`,
      allowAllOutbound: true,
    });

    const eksCluster = new EksCfnCluster(this, "EksCluster", {
      name: `workshop-${deploymentId}-eks`,
      version: "1.30",
      roleArn: eksClusterRole.roleArn,
      resourcesVpcConfig: {
        subnetIds: cloudVpc.selectSubnets({ subnetType: SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
        securityGroupIds: [eksSg.securityGroupId],
        endpointPublicAccess: true,
        endpointPrivateAccess: true,
      },
      accessConfig: {
        authenticationMode: "API_AND_CONFIG_MAP",
        bootstrapClusterCreatorAdminPermissions: true,
      },
    });
    // EKS takes ~12 min to create. Retain on stack delete — teardown.sh handles cleanup.
    eksCluster.cfnOptions.deletionPolicy = CfnDeletionPolicy.RETAIN;

    const eksNodegroup = new CfnNodegroup(this, "EksNodegroup", {
      clusterName: eksCluster.ref,
      nodegroupName: `workshop-${deploymentId}-nodes`,
      nodeRole: eksNodeRole.roleArn,
      subnets: cloudVpc.selectSubnets({ subnetType: SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
      instanceTypes: ["t3.medium"],
      scalingConfig: {
        minSize: 2,
        maxSize: 3,
        desiredSize: 2,
      },
      amiType: "AL2_x86_64",
      diskSize: 20,
    });
    eksNodegroup.addDependency(eksCluster);
    eksNodegroup.cfnOptions.deletionPolicy = CfnDeletionPolicy.RETAIN;

    // ── IoT Rule → MSK (Session 4 — raw telemetry to Kafka) ─────────────────
    // A second rule on the same topic feeds MSK alongside the existing S3 rule.
    // IoT's Kafka action uses a VPC destination; this approach uses a Lambda bridge
    // to keep setup simple (no VPC destination confirmation flow).
    const mskBridgeRole = new Role(this, "MskBridgeRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole"),
      ],
    });

    mskBridgeRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["kafka-cluster:Connect", "kafka-cluster:WriteData", "kafka-cluster:DescribeTopic"],
      resources: [`${mskCluster.attrArn}`, `${mskCluster.attrArn}/topic/raw.telemetry`],
    }));

    mskBridgeRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["kafka:GetBootstrapBrokers", "kafka:DescribeCluster"],
      resources: [mskCluster.attrArn],
    }));

    // MSK SASL credentials stored in Secrets Manager; Lambda reads at runtime
    const mskCredSecret = new Secret(this, "MskCredSecret", {
      secretName: `/workshop/${deploymentId}/msk-credentials`,
      description: `MSK SASL/SCRAM credentials for ${deploymentId}`,
      removalPolicy: RemovalPolicy.DESTROY,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: `workshop-${deploymentId}` }),
        generateStringKey: "password",
        excludePunctuation: true,
      },
    });
    mskCredSecret.grantRead(mskBridgeRole);

    const mskBridgeFn = new LambdaFn(this, "MskBridge", {
      functionName: `workshop-${deploymentId}-msk-bridge`,
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      // ESM handler: amplify/lambda/msk-bridge/ — install deps before deploy (pnpm install)
      handler: "index.handler",
      role: mskBridgeRole,
      timeout: Duration.seconds(10),
      vpc: cloudVpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [mskSg],
      environment: {
        MSK_CLUSTER_ARN: mskCluster.attrArn,
        MSK_CRED_SECRET: mskCredSecret.secretName,
        REGION: this.region,
      },
      code: Code.fromAsset("amplify/lambda/msk-bridge"),
    });

    mskBridgeFn.addPermission("AllowIoTInvokeMsk", {
      principal: new ServicePrincipal("iot.amazonaws.com"),
    });

    new CfnTopicRule(this, "IotToMskRule", {
      ruleName: `workshop_${deploymentId.replace(/-/g, "_")}_to_msk`,
      topicRulePayload: {
        sql: `SELECT *, topic() AS mqtt_topic, timestamp() AS ingest_ts FROM 'edge/${deploymentId}/+/telemetry'`,
        actions: [
          {
            lambda: {
              functionArn: mskBridgeFn.functionArn,
            },
          },
        ],
        ruleDisabled: false,
      },
    });

    // Allow MSK security group ingress from the Lambda (shares mskSg, so already open)
    mskSg.addIngressRule(Peer.ipv4(cloudVpc.vpcCidrBlock), Port.tcp(9096), "MSK SASL/SCRAM from VPC (Lambda bridge)");

    // ── Outputs ──────────────────────────────────────────────────────────────
    new CfnOutput(this, "DeploymentId", {
      exportName: `workshop-${deploymentId}-deployment-id`,
      value: deploymentId,
    });

    new CfnOutput(this, "WorkshopBucketName", {
      exportName: `workshop-${deploymentId}-bucket`,
      value: workshopBucket.bucketName,
    });

    new CfnOutput(this, "MskClusterArn", {
      exportName: `workshop-${deploymentId}-msk-arn`,
      value: mskCluster.attrArn,
    });

    new CfnOutput(this, "ClaimSecretArn", {
      exportName: `workshop-${deploymentId}-claim-secret`,
      value: claimSecret.secretArn,
    });

    new CfnOutput(this, "EventsApiId", {
      exportName: `workshop-${deploymentId}-events-api-id`,
      value: eventsApi.attrApiId,
    });

    new CfnOutput(this, "EventsApiHttpEndpoint", {
      exportName: `workshop-${deploymentId}-events-http`,
      value: eventsApi.attrDnsHttp,
    });

    new CfnOutput(this, "EventsApiRealtimeEndpoint", {
      exportName: `workshop-${deploymentId}-events-realtime`,
      value: eventsApi.attrDnsRealtime,
    });

    new CfnOutput(this, "EksClusterName", {
      exportName: `workshop-${deploymentId}-eks-cluster`,
      value: eksCluster.ref,
      description: "Run: aws eks update-kubeconfig --name <value> to configure kubectl",
    });

    new CfnOutput(this, "MskCredSecretArn", {
      exportName: `workshop-${deploymentId}-msk-cred-secret`,
      value: mskCredSecret.secretArn,
    });
  }
}
