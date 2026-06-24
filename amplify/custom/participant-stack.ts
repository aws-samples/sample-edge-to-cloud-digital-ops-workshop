import { Stack, StackProps, RemovalPolicy, Duration, CfnOutput, Fn, CustomResource } from "aws-cdk-lib";
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
} from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

export interface ParticipantStackProps extends StackProps {
  deploymentId: string;
  graphqlEndpoint: string; // CloudFormation export name — resolved via Fn.importValue
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
 *  - IoT Rule → shared MSK (raw.telemetry topic, SASL/SCRAM, stamps deployment_id)
 *  - IoT Rule → AppSync bridge Lambda → Amplify GraphQL subscription
 *  - Per-slot MSK SASL/SCRAM secret (references shared cluster + shared KMS key)
 *  - Kubernetes namespace (ws-slotNN) in the shared workshop-eks cluster
 *
 * Shared infrastructure (S3, MSK cluster, Flink, Glue, Athena) lives in
 * WorkshopPlatformStack and is imported via Fn.importValue.
 */
export class ParticipantStack extends Stack {
  readonly appSyncBridgeFn: LambdaFn;

  constructor(scope: Construct, id: string, props: ParticipantStackProps) {
    super(scope, id, props);

    const { deploymentId, graphqlEndpoint } = props;

    const edgeVpc = Vpc.fromLookup(this, "WorkshopEdgeVpc", { vpcName: "workshop-edge" });

    // ── Import shared platform resources ─────────────────────────────────────
    const sharedBucketName  = Fn.importValue("workshop-platform-bucket-name");
    const sharedBucketArn   = Fn.importValue("workshop-platform-bucket-arn");
    const mskClusterArn     = Fn.importValue("workshop-platform-msk-arn");
    const mskBootstrapScram = Fn.importValue("workshop-platform-msk-bootstrap-scram");
    const mskScramKeyArn    = Fn.importValue("workshop-platform-msk-scram-key-arn");

    // IoT VPC destination ARN is written to SSM by scripts/create-iot-vpc-dest.sh
    // after the platform stack deploys (CfnTopicRuleDestination can't be confirmed
    // within CloudFormation's stabilisation timeout).
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
    const slotIndex = parseInt(deploymentId.replace(/\D/g, "").slice(-2), 10) || 0;
    const edgeSubnetCidr = `10.0.${slotIndex}.0/24`;

    const edgeSubnet = new CfnSubnet(this, "EdgeSubnet", {
      vpcId: edgeVpc.vpcId,
      cidrBlock: edgeSubnetCidr,
      availabilityZone: `${this.region}a`,
      mapPublicIpOnLaunch: true,
      tags: [{ key: "Name", value: `workshop-edge-${deploymentId}` }],
    });

    const edgeRtb = new CfnRouteTable(this, "EdgeRtb", {
      vpcId: edgeVpc.vpcId,
      tags: [{ key: "Name", value: `workshop-edge-${deploymentId}-rtb` }],
    });

    // The edge VPC IGW is created once in WorkshopPlatformStack and shared by all slots.
    const edgeIgwId = Fn.importValue("workshop-platform-edge-igw-id");

    new CfnRoute(this, "EdgeDefaultRoute", {
      routeTableId: edgeRtb.ref,
      destinationCidrBlock: "0.0.0.0/0",
      gatewayId: edgeIgwId,
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
DEPLOYMENT_ID=$DEPLOYMENT_ID
IOT_ENDPOINT=$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text)
INTERVAL_S=5

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
        blockDeviceMappings: [
          {
            deviceName: "/dev/xvda",
            ebs: { volumeSize: 30, volumeType: "gp3", deleteOnTermination: true },
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
        APPSYNC_GRAPHQL_ENDPOINT: Fn.importValue(graphqlEndpoint),
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
    const mskAssociateScram = new AwsCustomResource(this, "MskAssociateScram", {
      onCreate: {
        service: "Kafka",
        action: "batchAssociateScramSecret",
        parameters: {
          ClusterArn: mskClusterArn,
          SecretArnList: [mskCredSecret.secretArn],
        },
        physicalResourceId: PhysicalResourceId.of(`MskScramAssoc-${deploymentId}`),
      } as AwsSdkCall,
      onDelete: {
        service: "Kafka",
        action: "batchDisassociateScramSecret",
        parameters: {
          ClusterArn: mskClusterArn,
          SecretArnList: [mskCredSecret.secretArn],
        },
      } as AwsSdkCall,
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });
    mskAssociateScram.node.addDependency(mskCredSecret);

    // ── IoT Rule → MSK (Session 4 — native Apache Kafka rule action) ──────────
    // IoT Kafka action writes to the shared MSK cluster via SASL/SCRAM.
    // The SQL stamps deployment_id so the Flink Iceberg sink can partition by it.
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

    new CfnOutput(this, "MskCredSecretArn", {
      exportName: `workshop-${deploymentId}-msk-cred-secret`,
      value: mskCredSecret.secretArn,
    });

    new CfnOutput(this, "SharedBucketName", {
      exportName: `workshop-${deploymentId}-shared-bucket`,
      value: sharedBucketName,
      description: "Shared S3 bucket — your Iceberg data is at telemetry/deployment_id=<your-id>/",
    });
  }
}
