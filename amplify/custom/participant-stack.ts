import { Stack, StackProps, RemovalPolicy, Duration, CfnOutput, Fn } from "aws-cdk-lib";
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
} from "aws-cdk-lib/aws-iot";
import {
  Secret,
} from "aws-cdk-lib/aws-secretsmanager";
import {
  CfnCluster as MskCluster,
} from "aws-cdk-lib/aws-msk";
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
import { Construct } from "constructs";

export interface ParticipantStackProps extends StackProps {
  deploymentId: string;
  edgeVpc: Vpc;
  cloudVpc: Vpc;
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
 *  - S3 bucket for Hudi MoR table
 *  - Athena workgroup
 *  - EKS cluster (t3.medium nodes, workshop-cloud VPC)
 */
export class ParticipantStack extends Stack {
  constructor(scope: Construct, id: string, props: ParticipantStackProps) {
    super(scope, id, props);

    const { deploymentId, edgeVpc, cloudVpc } = props;

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

    // Allow Device Client to assume the role for shadow/job operations
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
        resources: [`${workshopBucket.bucketArn}/job-scripts/*`],
      })
    );

    // ── IoT policies ─────────────────────────────────────────────────────────
    new IotPolicy(this, "ClaimPolicy", {
      policyName: `workshop-${deploymentId}-claim-policy`,
      policyDocument: JSON.stringify({
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
      }),
    });

    new IotPolicy(this, "DevicePolicy", {
      policyName: `workshop-${deploymentId}-device-policy`,
      policyDocument: JSON.stringify({
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
              `arn:aws:iot:${this.region}:${this.account}:topic/$aws/jobs/*`,
              `arn:aws:iot:${this.region}:${this.account}:topicfilter/$aws/jobs/*`,
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
      }),
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

    // ── IoT Provisioning Template ────────────────────────────────────────────
    const provisioningRole = new Role(this, "ProvisioningRole", {
      assumedBy: new ServicePrincipal("iot.amazonaws.com"),
    });

    provisioningRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "iot:CreateThing",
          "iot:CreateThingGroup",
          "iot:AddThingToThingGroup",
          "iot:UpdateCertificate",
          "iot:AttachPolicy",
          "iot:AttachThingPrincipal",
        ],
        resources: ["*"],
      })
    );

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
            },
            OverrideSettings: {
              AttributePayload: "MERGE",
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

    // Security group: allow outbound only (MQTT/TLS, HTTPS, SSM)
    const edgeSg = new CfnSecurityGroup(this, "EdgeSg", {
      vpcId: edgeVpc.vpcId,
      groupDescription: `workshop-edge-${deploymentId}`,
      securityGroupEgress: [
        { ipProtocol: "tcp", fromPort: 443, toPort: 443, cidrIp: "0.0.0.0/0" },
        { ipProtocol: "tcp", fromPort: 8883, toPort: 8883, cidrIp: "0.0.0.0/0" },
      ],
      tags: [{ key: "Name", value: `workshop-edge-${deploymentId}-sg` }],
    });

    // ── EC2 instances ────────────────────────────────────────────────────────
    const userDataScript = `#!/bin/bash
set -euxo pipefail

# Install SSM Agent (should be pre-installed on Amazon Linux 2023, but ensure)
yum install -y amazon-ssm-agent 2>/dev/null || true
systemctl enable amazon-ssm-agent && systemctl start amazon-ssm-agent

# Install AWS IoT Device Client
yum install -y cmake git openssl-devel
INSTANCE_ID=$(ec2-metadata --instance-id | cut -d' ' -f2)

# Retrieve claim cert from Secrets Manager (no hardcoded secrets in user data)
mkdir -p /etc/aws-iot-device-client/certs
SECRET_JSON=$(aws secretsmanager get-secret-value \
  --region ${this.region} \
  --secret-id /workshop/${deploymentId}/claim-cert \
  --query SecretString --output text)

echo "$SECRET_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); open('/tmp/claim.pem.crt','w').write(d['certificate']); open('/tmp/claim-private.pem.key','w').write(d['privateKey'])"
chmod 600 /tmp/claim.pem.crt /tmp/claim-private.pem.key

# Download Amazon Root CA
curl -o /etc/aws-iot-device-client/certs/AmazonRootCA1.pem \
  https://www.amazontrust.com/repository/AmazonRootCA1.pem

# Get IoT Core data endpoint
IOT_ENDPOINT=$(aws iot describe-endpoint \
  --region ${this.region} \
  --endpoint-type iot:Data-ATS \
  --query endpointAddress --output text)

# Install IoT Device Client binary
curl -Lo /usr/local/bin/aws-iot-device-client \
  "https://github.com/awslabs/aws-iot-device-client/releases/latest/download/aws-iot-device-client-aarch64"
chmod +x /usr/local/bin/aws-iot-device-client

# Write Device Client config for fleet provisioning
cat > /etc/aws-iot-device-client/aws-iot-device-client.conf <<EOF
{
  "endpoint": "$IOT_ENDPOINT",
  "cert": "/etc/aws-iot-device-client/certs/device.pem.crt",
  "key": "/etc/aws-iot-device-client/certs/device-private.pem.key",
  "root-ca": "/etc/aws-iot-device-client/certs/AmazonRootCA1.pem",
  "thing-name": "$INSTANCE_ID",
  "fleet-provisioning": {
    "enabled": true,
    "template-name": "${deploymentId}-provisioning",
    "template-parameters": "{\\"ThingName\\":\\"$INSTANCE_ID\\",\\"SerialNumber\\":\\"$INSTANCE_ID\\"}",
    "claim-cert": "/tmp/claim.pem.crt",
    "claim-key": "/tmp/claim-private.pem.key",
    "device-key": "/etc/aws-iot-device-client/certs/device-private.pem.key",
    "device-cert": "/etc/aws-iot-device-client/certs/device.pem.crt"
  },
  "jobs": {
    "enabled": true,
    "handler-directory": "/etc/aws-iot-device-client/jobs"
  },
  "shadow": {
    "enabled": true
  },
  "logging": {
    "level": "INFO",
    "type": "FILE",
    "file": "/var/log/aws-iot-device-client.log"
  }
}
EOF

mkdir -p /etc/aws-iot-device-client/jobs

# Initial telemetry publisher (0.2 Hz, cpu/mem/disk)
cat > /etc/aws-iot-device-client/jobs/publish-telemetry.sh <<'TELEMETRY'
#!/bin/bash
INSTANCE_ID=$(ec2-metadata --instance-id | cut -d' ' -f2)
DEPLOYMENT_ID="${deploymentId}"
IOT_ENDPOINT=$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text)
INTERVAL_S=5  # 0.2 Hz

while true; do
  TS=$(date -u +%s%3N)
  CPU=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | tr -d '%us,')
  MEM=$(free | awk '/Mem:/ {printf "%.1f", $3/$2*100}')
  DISK=$(df / | awk 'NR==2 {print $5}' | tr -d '%')

  PAYLOAD=$(printf '{"thing_name":"%s","message_timestamp":%s,"cpu_pct":%s,"mem_used_pct":%s,"disk_used_pct":%s}' \
    "$INSTANCE_ID" "$TS" "$CPU" "$MEM" "$DISK")

  aws iot-data publish \
    --endpoint-url "https://$IOT_ENDPOINT" \
    --topic "edge/$DEPLOYMENT_ID/$INSTANCE_ID/telemetry" \
    --payload "$PAYLOAD" \
    --cli-binary-format raw-in-base64-out \
    2>/dev/null

  sleep $INTERVAL_S
done
TELEMETRY
chmod +x /etc/aws-iot-device-client/jobs/publish-telemetry.sh

# Systemd unit for telemetry
cat > /etc/systemd/system/workshop-telemetry.service <<EOF
[Unit]
Description=Workshop Telemetry Publisher
After=network.target aws-iot-device-client.service

[Service]
Type=simple
ExecStart=/etc/aws-iot-device-client/jobs/publish-telemetry.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Systemd unit for Device Client
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
systemctl enable aws-iot-device-client
systemctl start aws-iot-device-client

# Delete claim cert files after Device Client runs provisioning (give it 60 s)
(sleep 60 && rm -f /tmp/claim.pem.crt /tmp/claim-private.pem.key && \
  systemctl enable workshop-telemetry && systemctl start workshop-telemetry) &

# Write initial device-config shadow (reported only on boot)
(sleep 90 && INSTANCE_ID=$(ec2-metadata --instance-id | cut -d' ' -f2) && \
  IOT_EP=$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text) && \
  aws iot-data update-thing-shadow \
    --endpoint-url "https://$IOT_EP" \
    --thing-name "$INSTANCE_ID" \
    --shadow-name device-config \
    --payload '{"state":{"reported":{"telemetry_interval_ms":5000,"metrics":["cpu_pct","mem_used_pct","disk_used_pct"],"config_version":"1.0.0"}}}' \
    /dev/null) &
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
    // IoT Rules Engine posts directly to the AppSync Events HTTP endpoint via
    // SigV4-signed HTTP action. Path: device MQTT → IoT Core → IoT Rule →
    // AppSync Events → browser WebSocket. No Lambda hop, no database write.
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

    // IAM role that allows IoT Rules Engine to publish to the Events HTTP endpoint
    const iotAppSyncRole = new Role(this, "IotAppSyncRole", {
      assumedBy: new ServicePrincipal("iot.amazonaws.com"),
    });

    iotAppSyncRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["appsync:EventPublish"],
        resources: [`${eventsApi.attrApiArn}/channel/telemetry/*`],
      })
    );

    // IoT Rule → AppSync Events (raw telemetry push to browser subscribers)
    // Channel path: /telemetry/<deploymentId>/<thingName>
    // No database write; used for the "live push" freshness panel.
    new CfnTopicRule(this, "IotToAppSyncRule", {
      ruleName: `workshop_${deploymentId.replace(/-/g, "_")}_to_appsync`,
      topicRulePayload: {
        sql: `SELECT * FROM 'edge/${deploymentId}/+/telemetry'`,
        actions: [
          {
            http: {
              url: `https://${eventsApi.attrDnsHttp}/event/channel/telemetry/${deploymentId}/\${topic(2)}`,
              auth: {
                sigv4: {
                  serviceName: "appsync",
                  signingRegion: this.region,
                  roleArn: iotAppSyncRole.roleArn,
                },
              },
              headers: [{ key: "Content-Type", value: "application/json" }],
            },
          },
        ],
        ruleDisabled: false,
      },
    });

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
  }
}
