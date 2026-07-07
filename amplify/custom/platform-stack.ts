import { Stack, StackProps, CfnOutput, CfnDeletionPolicy, RemovalPolicy, Fn, CfnJson } from "aws-cdk-lib";
import {
  Vpc,
  SubnetType,
  GatewayVpcEndpointAwsService,
  IpAddresses,
  SecurityGroup,
  Peer,
  Port,
  CfnNatGateway,
} from "aws-cdk-lib/aws-ec2";
import {
  Role,
  ServicePrincipal,
  ManagedPolicy,
  PolicyStatement,
  Effect,
  FederatedPrincipal,
  OpenIdConnectProvider,
  Conditions,
} from "aws-cdk-lib/aws-iam";
import {
  CfnCluster as EksCfnCluster,
  CfnNodegroup,
} from "aws-cdk-lib/aws-eks";
import {
  CfnCluster as MskCluster,
} from "aws-cdk-lib/aws-msk";
import {
  Bucket,
  BlockPublicAccess,
  BucketEncryption,
} from "aws-cdk-lib/aws-s3";
import {
  Key as KmsKey,
} from "aws-cdk-lib/aws-kms";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from "aws-cdk-lib/custom-resources";
import { CfnApplication as CfnFlinkApplication } from "aws-cdk-lib/aws-kinesisanalyticsv2";
import { CfnWorkGroup } from "aws-cdk-lib/aws-athena";
import { Construct } from "constructs";

export interface PlatformStackProps extends StackProps {
  /**
   * Whether to create the Managed Flink app. Defaults to true.
   *
   * The Flink app reads its code JAR from the shared S3 bucket created in
   * this same stack — on a fresh account that bucket (and JAR) don't exist
   * yet, so the very first deploy must skip the Flink app or CloudFormation
   * rolls back the entire stack (VPCs/EKS/MSK included) when it can't find
   * the JAR. scripts/sandbox-all.sh sets this to false for that first pass,
   * uploads the JAR once the bucket exists, then redeploys with it back on.
   */
  readonly deployFlinkApp?: boolean;
}

/**
 * Shared platform infrastructure — deployed once per account/region.
 *
 * workshop-edge  10.0.0.0/16  — edge EC2 instances, private-with-egress /24 subnets per slot
 * workshop-cloud 10.1.0.0/16  — shared EKS cluster, per-slot MSK clusters
 *
 * EKS cluster is shared across all participants. Each participant slot gets its
 * own namespace (e.g. ws-slot00) with RBAC scoped to that namespace. The MSK
 * cluster is likewise shared; each slot gets its own SCRAM credentials
 * (created in ParticipantStack).
 */
export class PlatformStack extends Stack {
  public readonly edgeVpc: Vpc;
  public readonly cloudVpc: Vpc;

  constructor(scope: Construct, id: string, props?: PlatformStackProps) {
    super(scope, id, props);

    // Edge VPC: public + private-with-egress subnets, 10.0.0.0/16.
    // Mirrors the cloud VPC below — one shared NAT gateway, edge instances land
    // in the private tier so they aren't directly internet-reachable. Each
    // participant slot carves its EdgeInstance subnet out of the private tier
    // (see ParticipantStack) rather than creating its own subnet/IGW/route table.
    this.edgeVpc = new Vpc(this, "WorkshopEdgeVpc", {
      vpcName: "workshop-edge",
      ipAddresses: IpAddresses.cidr("10.0.0.0/16"),
      maxAzs: 3,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: "edge-public",
          subnetType: SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "edge-private",
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // S3 gateway endpoint on the edge VPC — the IoT Device Client build/binary
    // pulls and job-script downloads hit S3; this keeps that traffic off the
    // NAT gateway's metered data-processing path.
    this.edgeVpc.addGatewayEndpoint("EdgeS3Endpoint", {
      service: GatewayVpcEndpointAwsService.S3,
    });

    // Single shared NAT gateway for the edge VPC's private tier. ParticipantStack
    // reads this ID (via SSM, written by the sandbox scripts) so each slot's own
    // EdgeInstance subnet routes 0.0.0.0/0 through it instead of an IGW.
    const [edgeNatGateway] = this.edgeVpc.node.findAll().filter(
      (n): n is CfnNatGateway => n instanceof CfnNatGateway
    );
    new CfnOutput(this, "EdgeVpcId", {
      exportName: "workshop-platform-edge-vpc-id",
      value: this.edgeVpc.vpcId,
    });
    new CfnOutput(this, "EdgeNatGatewayId", {
      exportName: "workshop-platform-edge-nat-gateway-id",
      value: edgeNatGateway.ref,
    });

    // Cloud VPC: private + public subnets, 10.1.0.0/16.
    // Hosts EKS and MSK across three AZs.
    this.cloudVpc = new Vpc(this, "WorkshopCloudVpc", {
      vpcName: "workshop-cloud",
      ipAddresses: IpAddresses.cidr("10.1.0.0/16"),
      maxAzs: 3,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: "cloud-public",
          subnetType: SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "cloud-private",
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // S3 gateway endpoint on cloud VPC so MSK Connect and EKS pods don't
    // hairpin through the NAT gateway for S3 writes.
    this.cloudVpc.addGatewayEndpoint("S3Endpoint", {
      service: GatewayVpcEndpointAwsService.S3,
    });

    // ── Shared EKS cluster ───────────────────────────────────────────────────
    // One cluster hosts all participant namespaces. Provisioned here (pre-workshop)
    // so participants don't wait ~12 min for cluster creation during Session 4.
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
      vpc: this.cloudVpc,
      description: "workshop-eks shared cluster",
      allowAllOutbound: true,
    });

    const eksCluster = new EksCfnCluster(this, "EksCluster", {
      name: "workshop-eks",
      version: "1.30",
      roleArn: eksClusterRole.roleArn,
      resourcesVpcConfig: {
        subnetIds: this.cloudVpc.selectSubnets({ subnetType: SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
        securityGroupIds: [eksSg.securityGroupId],
        endpointPublicAccess: true,
        endpointPrivateAccess: true,
      },
      accessConfig: {
        authenticationMode: "API_AND_CONFIG_MAP",
        bootstrapClusterCreatorAdminPermissions: true,
      },
    });

    const eksNodegroup = new CfnNodegroup(this, "EksNodegroup", {
      clusterName: eksCluster.ref,
      nodegroupName: "workshop-nodes",
      nodeRole: eksNodeRole.roleArn,
      subnets: this.cloudVpc.selectSubnets({ subnetType: SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
      instanceTypes: ["t3.medium"],
      scalingConfig: {
        minSize: 2,
        maxSize: 8,
        desiredSize: 2,
      },
      amiType: "AL2_x86_64",
      diskSize: 20,
    });
    eksNodegroup.addDependency(eksCluster);

    new CfnOutput(this, "EksClusterName", {
      exportName: "workshop-eks-cluster-name",
      value: eksCluster.ref,
      description: "Run: aws eks update-kubeconfig --name workshop-eks to configure kubectl",
    });

    // ── IRSA for cloud RisingWave (S3 state store) ──────────────────────────
    // One OIDC provider + one IAM role, shared across all participant namespaces.
    // Each participant's risingwave-cloud ServiceAccount (created manually in
    // Session 4, Block 1) assumes this role via IRSA to read/write its own
    // workshop-<slot>-<account>-risingwave-state bucket.
    const eksOidcProvider = new OpenIdConnectProvider(this, "EksOidcProvider", {
      url: eksCluster.attrOpenIdConnectIssuerUrl,
    });
    const oidcProviderHost = Fn.select(1, Fn.split("//", eksCluster.attrOpenIdConnectIssuerUrl));
    // Each condition operator's inner map has a key built from a deploy-time
    // token (the OIDC host), so each map must be resolved via CfnJson rather
    // than a plain object literal.
    const audCondition = new CfnJson(this, "RisingwaveS3AudCondition", {
      value: { [`${oidcProviderHost}:aud`]: "sts.amazonaws.com" },
    });
    const subCondition = new CfnJson(this, "RisingwaveS3SubCondition", {
      value: { [`${oidcProviderHost}:sub`]: "system:serviceaccount:*:risingwave-cloud" },
    });

    const risingwaveS3Role = new Role(this, "RisingwaveS3Role", {
      roleName: "workshop-risingwave-s3",
      assumedBy: new FederatedPrincipal(
        eksOidcProvider.openIdConnectProviderArn,
        {
          StringEquals: audCondition,
          StringLike: subCondition,
        } as unknown as Conditions,
        "sts:AssumeRoleWithWebIdentity"
      ),
    });
    risingwaveS3Role.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["s3:ListBucket"],
      resources: [`arn:aws:s3:::workshop-*-${this.account}-risingwave-state`],
    }));
    risingwaveS3Role.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      resources: [`arn:aws:s3:::workshop-*-${this.account}-risingwave-state/*`],
    }));

    new CfnOutput(this, "RisingwaveS3RoleArn", {
      exportName: "workshop-platform-risingwave-s3-role-arn",
      value: risingwaveS3Role.roleArn,
    });

    // ── Shared S3 bucket ─────────────────────────────────────────────────────
    // All participant slots share one bucket. Data is partitioned by deployment_id
    // inside the bucket (e.g. telemetry/deployment_id=ws-slot00/…).
    const workshopBucket = new Bucket(this, "WorkshopBucket", {
      bucketName: `workshop-platform-${this.account}`,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      versioned: false,
    });

    new CfnOutput(this, "WorkshopBucketName", {
      exportName: "workshop-platform-bucket-name",
      value: workshopBucket.bucketName,
    });
    new CfnOutput(this, "WorkshopBucketArn", {
      exportName: "workshop-platform-bucket-arn",
      value: workshopBucket.bucketArn,
    });

    // ── KMS key for MSK SCRAM secrets ────────────────────────────────────────
    // MSK requires SCRAM secrets to use a customer-managed key (not the default
    // AWS-managed key). One key shared across all participant slots.
    const mskScramKey = new KmsKey(this, "MskScramKey", {
      description: "CMK for workshop MSK SCRAM secrets",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    new CfnOutput(this, "MskScramKeyArn", {
      exportName: "workshop-platform-msk-scram-key-arn",
      value: mskScramKey.keyArn,
    });

    // ── Shared MSK cluster ───────────────────────────────────────────────────
    // One provisioned MSK cluster shared across all participant slots.
    // Each slot gets its own SCRAM credentials (created in ParticipantStack).
    const mskSg = new SecurityGroup(this, "MskSg", {
      vpc: this.cloudVpc,
      description: "workshop-msk shared cluster",
      allowAllOutbound: true,
    });
    mskSg.addIngressRule(Peer.ipv4(this.cloudVpc.vpcCidrBlock), Port.tcp(9096), "MSK SASL/SCRAM from VPC");
    mskSg.addIngressRule(Peer.ipv4(this.cloudVpc.vpcCidrBlock), Port.tcp(9098), "MSK IAM from VPC");

    const mskCluster = new MskCluster(this, "MskCluster", {
      clusterName: "workshop-platform-msk",
      kafkaVersion: "3.6.0",
      numberOfBrokerNodes: 2,
      brokerNodeGroupInfo: {
        instanceType: "kafka.m5.large",
        clientSubnets: this.cloudVpc.selectSubnets({ subnetType: SubnetType.PRIVATE_WITH_EGRESS }).subnetIds.slice(0, 2),
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
          iam: {
            enabled: true,
          },
        },
      },
      encryptionInfo: {
        encryptionInTransit: {
          clientBroker: "TLS",
          inCluster: true,
        },
        encryptionAtRest: {
          dataVolumeKmsKeyId: mskScramKey.keyId,
        },
      },
    });

    new CfnOutput(this, "MskClusterArn", {
      exportName: "workshop-platform-msk-arn",
      value: mskCluster.attrArn,
    });

    // Resolve SASL/SCRAM bootstrap broker string via a custom resource —
    // MSK's CFN resource doesn't expose it as a direct attribute.
    const mskBootstrapLookup = new AwsCustomResource(this, "MskBootstrapScramLookup", {
      onCreate: {
        service: "Kafka",
        action: "getBootstrapBrokers",
        parameters: { ClusterArn: mskCluster.attrArn },
        physicalResourceId: PhysicalResourceId.of("MskBootstrapScramLookup"),
        outputPaths: ["BootstrapBrokerStringSaslScram"],
      },
      onUpdate: {
        service: "Kafka",
        action: "getBootstrapBrokers",
        parameters: { ClusterArn: mskCluster.attrArn },
        physicalResourceId: PhysicalResourceId.of("MskBootstrapScramLookup"),
        outputPaths: ["BootstrapBrokerStringSaslScram"],
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: [mskCluster.attrArn],
      }),
    });
    mskBootstrapLookup.node.addDependency(mskCluster);

    new CfnOutput(this, "MskBootstrapScram", {
      exportName: "workshop-platform-msk-bootstrap-scram",
      value: mskBootstrapLookup.getResponseField("BootstrapBrokerStringSaslScram"),
    });

    // ── IoT VPC Destination role + security group + outputs ─────────────────
    // CfnTopicRuleDestination stays IN_PROGRESS until IoT successfully attaches
    // ENIs — this can exceed CloudFormation's stabilisation timeout. Instead, we
    // create the destination via CLI in sandbox-all.sh after the stack deploys
    // and write the confirmed ARN to SSM (/workshop/platform/iot-vpc-dest-arn).
    // ParticipantStack reads that SSM parameter at synth time via AwsCustomResource.

    // Dedicated SG for IoT VPC destination ENIs. Allows TCP 443 inbound for
    // the IoT health-check handshake (the MSK SG only opens 9096/9098).
    const iotVpcDestSg = new SecurityGroup(this, "IotVpcDestSg", {
      vpc: this.cloudVpc,
      description: "IoT VPC destination ENIs - allow TCP 443 for IoT health-check",
      allowAllOutbound: true,
    });
    iotVpcDestSg.addIngressRule(Peer.anyIpv4(), Port.tcp(443), "IoT health-check");

    new CfnOutput(this, "IotVpcDestSgId", {
      exportName: "workshop-platform-iot-vpc-dest-sg-id",
      value: iotVpcDestSg.securityGroupId,
    });

    const iotVpcDestRole = new Role(this, "IotVpcDestRole", {
      assumedBy: new ServicePrincipal("iot.amazonaws.com"),
    });
    iotVpcDestRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "ec2:CreateNetworkInterface",
        "ec2:CreateNetworkInterfacePermission",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DeleteNetworkInterface",
        "ec2:DescribeVpcs",
        "ec2:DescribeSubnets",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeVpcAttribute",
      ],
      resources: ["*"],
    }));

    // Outputs consumed by scripts/create-iot-vpc-dest.sh
    new CfnOutput(this, "IotVpcDestRoleArn", {
      exportName: "workshop-platform-iot-vpc-dest-role-arn",
      value: iotVpcDestRole.roleArn,
    });
    new CfnOutput(this, "CloudVpcId", {
      exportName: "workshop-platform-cloud-vpc-id",
      value: this.cloudVpc.vpcId,
    });
    new CfnOutput(this, "CloudPrivateSubnets", {
      exportName: "workshop-platform-cloud-private-subnets",
      value: this.cloudVpc.selectSubnets({ subnetType: SubnetType.PRIVATE_WITH_EGRESS }).subnetIds.join(","),
    });
    new CfnOutput(this, "MskSgId", {
      exportName: "workshop-platform-msk-sg-id",
      value: mskSg.securityGroupId,
    });

    // ── Managed Flink (MSK → Iceberg → S3) ──────────────────────────────────
    // Reads raw.telemetry from MSK via IAM auth, writes Apache Iceberg table
    // to S3 via GlueCatalog so Athena sees live snapshots.
    if (props?.deployFlinkApp !== false) {
    // Resolve IAM bootstrap broker string (port 9098) via custom resource.
    const mskBootstrapIamLookup = new AwsCustomResource(this, "MskBootstrapIamLookup", {
      onCreate: {
        service: "Kafka",
        action: "getBootstrapBrokers",
        parameters: { ClusterArn: mskCluster.attrArn },
        physicalResourceId: PhysicalResourceId.of("MskBootstrapIamLookup"),
        outputPaths: ["BootstrapBrokerStringSaslIam"],
      },
      onUpdate: {
        service: "Kafka",
        action: "getBootstrapBrokers",
        parameters: { ClusterArn: mskCluster.attrArn },
        physicalResourceId: PhysicalResourceId.of("MskBootstrapIamLookup"),
        outputPaths: ["BootstrapBrokerStringSaslIam"],
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: [mskCluster.attrArn],
      }),
    });
    mskBootstrapIamLookup.node.addDependency(mskCluster);

    const flinkRole = new Role(this, "FlinkRole", {
      assumedBy: new ServicePrincipal("kinesisanalytics.amazonaws.com"),
    });

    flinkRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetBucketLocation",
      ],
      resources: [workshopBucket.bucketArn, `${workshopBucket.bucketArn}/*`],
    }));

    flinkRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "glue:GetDatabase",
        "glue:CreateDatabase",
        "glue:GetTable",
        "glue:GetTables",
        "glue:CreateTable",
        "glue:UpdateTable",
        "glue:DeleteTable",
        "glue:GetPartition",
        "glue:GetPartitions",
        "glue:CreatePartition",
        "glue:UpdatePartition",
        "glue:DeletePartition",
        "glue:BatchCreatePartition",
        "glue:BatchDeletePartition",
      ],
      resources: [
        `arn:aws:glue:${this.region}:${this.account}:catalog`,
        `arn:aws:glue:${this.region}:${this.account}:database/workshop_telemetry`,
        `arn:aws:glue:${this.region}:${this.account}:table/workshop_telemetry/*`,
      ],
    }));

    flinkRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
      ],
      resources: ["*"],
    }));

    flinkRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "kafka-cluster:Connect",
        "kafka-cluster:DescribeCluster",
        "kafka:DescribeCluster",
        "kafka:GetBootstrapBrokers",
      ],
      resources: [mskCluster.attrArn],
    }));

    flinkRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "kafka-cluster:DescribeTopic",
        "kafka-cluster:ReadData",
      ],
      resources: [`arn:aws:kafka:${this.region}:${this.account}:topic/workshop-platform-msk/*/*`],
    }));

    flinkRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "kafka-cluster:DescribeGroup",
        "kafka-cluster:AlterGroup",
      ],
      resources: [`arn:aws:kafka:${this.region}:${this.account}:group/workshop-platform-msk/*/*`],
    }));

    flinkRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "ec2:DescribeVpcs",
        "ec2:DescribeSubnets",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeDhcpOptions",
        "ec2:DescribeNetworkInterfaces",
        "ec2:CreateNetworkInterface",
        "ec2:CreateNetworkInterfacePermission",
        "ec2:DeleteNetworkInterface",
      ],
      resources: ["*"],
    }));

    const flinkApp = new CfnFlinkApplication(this, "FlinkIcebergSink", {
      applicationName: "workshop-iceberg-sink",
      runtimeEnvironment: "FLINK-1_18",
      serviceExecutionRole: flinkRole.roleArn,
      applicationConfiguration: {
        applicationCodeConfiguration: {
          codeContent: {
            s3ContentLocation: {
              bucketArn: workshopBucket.bucketArn,
              fileKey: "flink-apps/flink-iceberg-sink-1.0.0.jar",
            },
          },
          codeContentType: "ZIPFILE",
        },
        environmentProperties: {
          propertyGroups: [
            {
              propertyGroupId: "FlinkApplicationProperties",
              propertyMap: {
                BOOTSTRAP_SERVERS: mskBootstrapIamLookup.getResponseField("BootstrapBrokerStringSaslIam"),
                S3_BASE_PATH: `s3://${workshopBucket.bucketName}/telemetry`,
                GLUE_DB: "workshop_telemetry",
              },
            },
          ],
        },
        flinkApplicationConfiguration: {
          checkpointConfiguration: {
            configurationType: "CUSTOM",
            checkpointingEnabled: true,
            checkpointInterval: 60000,
            minPauseBetweenCheckpoints: 5000,
          },
          monitoringConfiguration: {
            configurationType: "CUSTOM",
            metricsLevel: "APPLICATION",
            logLevel: "INFO",
          },
          parallelismConfiguration: {
            configurationType: "CUSTOM",
            parallelism: 2,
            parallelismPerKpu: 1,
            autoScalingEnabled: false,
          },
        },
        vpcConfigurations: [
          {
            subnetIds: this.cloudVpc.selectSubnets({ subnetType: SubnetType.PRIVATE_WITH_EGRESS }).subnetIds.slice(0, 2),
            securityGroupIds: [mskSg.securityGroupId],
          },
        ],
      },
    });
    flinkApp.node.addDependency(mskCluster);
    flinkApp.node.addDependency(mskBootstrapIamLookup);

    new CfnOutput(this, "FlinkAppName", {
      exportName: "workshop-platform-flink-app-name",
      value: flinkApp.ref,
    });
    }

    // ── Athena workgroup ─────────────────────────────────────────────────────
    // Shared across all participant slots. scripts/athena-query.sh defaults to
    // this workgroup (ATHENA_WORKGROUP=workshop-shared).
    const athenaWorkGroup = new CfnWorkGroup(this, "AthenaWorkGroup", {
      name: "workshop-shared",
      workGroupConfiguration: {
        engineVersion: {
          selectedEngineVersion: "Athena engine version 3",
        },
        resultConfiguration: {
          outputLocation: `s3://${workshopBucket.bucketName}/athena-results/`,
        },
      },
    });

    new CfnOutput(this, "AthenaWorkGroupName", {
      exportName: "workshop-platform-athena-workgroup-name",
      value: athenaWorkGroup.name,
    });

    // Fleet Indexing: enable REGISTRY_AND_SHADOW with named shadow indexing.
    // Required for Session 3 shadow-based fleet queries
    // (e.g. shadow.name.device-health.reported.cpu_pct).
    // This is an account-wide setting — one Custom Resource in PlatformStack
    // covers all participant slots.
    new AwsCustomResource(this, "FleetIndexingConfig", {
      onCreate: {
        service: "Iot",
        action: "updateIndexingConfiguration",
        parameters: {
          thingIndexingConfiguration: {
            thingIndexingMode: "REGISTRY_AND_SHADOW",
            thingConnectivityIndexingMode: "STATUS",
            deviceDefenderIndexingMode: "OFF",
            namedShadowIndexingMode: "ON",
            filter: {
              namedShadowNames: ["device-health", "device-config", "app-deployment", "$package"],
            },
          },
        },
        physicalResourceId: PhysicalResourceId.of("FleetIndexingConfig"),
      },
      onUpdate: {
        service: "Iot",
        action: "updateIndexingConfiguration",
        parameters: {
          thingIndexingConfiguration: {
            thingIndexingMode: "REGISTRY_AND_SHADOW",
            thingConnectivityIndexingMode: "STATUS",
            deviceDefenderIndexingMode: "OFF",
            namedShadowIndexingMode: "ON",
            filter: {
              namedShadowNames: ["device-health", "device-config", "app-deployment", "$package"],
            },
          },
        },
        physicalResourceId: PhysicalResourceId.of("FleetIndexingConfig"),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });
  }
}
