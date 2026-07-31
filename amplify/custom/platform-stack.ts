import { Stack, StackProps, CfnOutput, CfnDeletionPolicy, RemovalPolicy, Duration, Fn, CfnJson } from "aws-cdk-lib";
import {
  Vpc,
  SubnetType,
  GatewayVpcEndpointAwsService,
  IpAddresses,
  SecurityGroup,
  Peer,
  Port,
  CfnNatGateway,
  CfnVPCPeeringConnection,
  CfnRoute,
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
  CfnAccessEntry,
  CfnAddon,
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
import { CfnDeliveryStream } from "aws-cdk-lib/aws-kinesisfirehose";
import { CfnDatabase, CfnTable } from "aws-cdk-lib/aws-glue";
import { CfnWorkGroup } from "aws-cdk-lib/aws-athena";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

export interface PlatformStackProps extends StackProps {
  /**
   * IAM principal ARNs (e.g. the CI role, a facilitator's admin role) to grant
   * cluster-scoped EKS access via an access entry — so they can run kubectl/helm
   * against workshop-eks without ever needing the "creator admin" bootstrap
   * (which only applies to whoever ran the very first `cdk deploy`). Defaults
   * to none. Cluster-scoped because these principals need to exercise the
   * one-time operator installs (cert-manager, risingwave-operator, cnpg) that
   * span every participant namespace — participants get a narrower,
   * namespace-scoped entry instead (see ParticipantStack).
   */
  readonly eksAdminPrincipalArns?: string[];
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
    // reads this ID from SSM so each slot's own EdgeInstance subnet routes
    // 0.0.0.0/0 through it instead of an IGW.
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
    // Publish the NAT gateway ID to SSM as part of the platform stack itself, so
    // the parameter's lifecycle is tied to the NAT gateway that owns it: it is
    // (re)created with this stack and torn down with it. This is what keeps the
    // value fresh across a platform teardown/rebuild — previously the sandbox
    // scripts wrote it out-of-band, so a stale ID could survive a rebuild and
    // every slot would route to a deleted natGatewayId and roll back (#114).
    new StringParameter(this, "EdgeNatGatewayIdParam", {
      parameterName: "/workshop/platform/edge-nat-gateway-id",
      stringValue: edgeNatGateway.ref,
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

    // ── Edge ↔ Cloud VPC peering ─────────────────────────────────────────────
    // The Session-5 "WAN relay" (Redpanda Connect in the edge VPC) forwards
    // edge `sensors.raw.*` to the shared MSK cluster in the cloud VPC. MSK is
    // private-only, so without a network path between 10.0.0.0/16 and
    // 10.1.0.0/16 the relay's producer times out dialing the brokers. Peer the
    // two VPCs (same account+region → auto-accepted) and add reciprocal routes
    // on every subnet route table in both VPCs. The MSK security group is also
    // opened to the edge CIDR below (see mskSg).
    const edgeCloudPeering = new CfnVPCPeeringConnection(this, "EdgeCloudPeering", {
      vpcId: this.edgeVpc.vpcId,
      peerVpcId: this.cloudVpc.vpcId,
      tags: [{ key: "Name", value: "workshop-edge-to-cloud" }],
    });

    // Route every subnet's table to the peer CIDR, in both directions. Each
    // subnet (public + private) carries a routeTable we attach a CfnRoute to.
    [...this.edgeVpc.publicSubnets, ...this.edgeVpc.privateSubnets].forEach(
      (subnet, i) => {
        new CfnRoute(this, `EdgeToCloudRoute${i}`, {
          routeTableId: subnet.routeTable.routeTableId,
          destinationCidrBlock: this.cloudVpc.vpcCidrBlock,
          vpcPeeringConnectionId: edgeCloudPeering.ref,
        });
      }
    );
    [...this.cloudVpc.publicSubnets, ...this.cloudVpc.privateSubnets].forEach(
      (subnet, i) => {
        new CfnRoute(this, `CloudToEdgeRoute${i}`, {
          routeTableId: subnet.routeTable.routeTableId,
          destinationCidrBlock: this.edgeVpc.vpcCidrBlock,
          vpcPeeringConnectionId: edgeCloudPeering.ref,
        });
      }
    );

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

    // Cluster-scoped access entries for admin/CI principals. `accessConfig.
    // bootstrapClusterCreatorAdminPermissions` only grants admin to whoever ran
    // the very first `cdk deploy` — every other principal (a re-run CI role, a
    // second facilitator) is invisible to the cluster's RBAC until explicitly
    // added here. AmazonEKSAdminPolicy (not ...ClusterAdminPolicy) covers the
    // namespace/secret/deployment/CRD-install operations block-1-deploy.md
    // needs without granting Kubernetes RBAC-management rights.
    (props?.eksAdminPrincipalArns ?? []).forEach((principalArn, i) => {
      const accessEntry = new CfnAccessEntry(this, `EksAdminAccessEntry${i}`, {
        clusterName: eksCluster.ref,
        principalArn,
        type: "STANDARD",
        accessPolicies: [
          {
            policyArn: "arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminPolicy",
            accessScope: { type: "cluster" },
          },
        ],
      });
      accessEntry.node.addDependency(eksCluster);
    });

    // ── IRSA for cloud RisingWave (S3 state store) ──────────────────────────
    // One OIDC provider + one IAM role, shared across all participant namespaces.
    // Each participant's risingwave-cloud ServiceAccount (created manually in
    // Session 4, Block 1) assumes this role via IRSA to read/write its own
    // workshop-<slot>-<account>-risingwave-state bucket.
    // `clientIds` MUST include sts.amazonaws.com — it becomes the OIDC
    // provider's audience list, and STS rejects every AssumeRoleWithWebIdentity
    // call (InvalidIdentityToken) whose token audience isn't listed. Without it
    // IRSA silently fails for the EBS CSI driver, RisingWave, and every other
    // service account that assumes an IAM role via this provider.
    const eksOidcProvider = new OpenIdConnectProvider(this, "EksOidcProvider", {
      url: eksCluster.attrOpenIdConnectIssuerUrl,
      clientIds: ["sts.amazonaws.com"],
    });
    const oidcProviderHost = Fn.select(1, Fn.split("//", eksCluster.attrOpenIdConnectIssuerUrl));

    // ── EBS CSI driver ──────────────────────────────────────────────────────
    // EKS 1.30 ships with the in-tree `kubernetes.io/aws-ebs` provisioner
    // disabled (CSI migration is complete), so without the EBS CSI driver addon
    // every PersistentVolumeClaim — TimescaleDB (CloudNativePG), RisingWave's
    // meta/state store, etc. — stays `Pending` forever and Session 4/5 pods
    // never schedule. The driver needs its own IRSA role scoped to the
    // `ebs-csi-controller-sa` service account in kube-system.
    const ebsCsiSubCondition = new CfnJson(this, "EbsCsiSubCondition", {
      value: {
        [`${oidcProviderHost}:sub`]:
          "system:serviceaccount:kube-system:ebs-csi-controller-sa",
        [`${oidcProviderHost}:aud`]: "sts.amazonaws.com",
      },
    });
    const ebsCsiRole = new Role(this, "EbsCsiDriverRole", {
      assumedBy: new FederatedPrincipal(
        eksOidcProvider.openIdConnectProviderArn,
        { StringEquals: ebsCsiSubCondition } as unknown as Conditions,
        "sts:AssumeRoleWithWebIdentity"
      ),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonEBSCSIDriverPolicy"),
      ],
    });
    const ebsCsiAddon = new CfnAddon(this, "EbsCsiAddon", {
      clusterName: eksCluster.ref,
      addonName: "aws-ebs-csi-driver",
      serviceAccountRoleArn: ebsCsiRole.roleArn,
      resolveConflicts: "OVERWRITE",
    });
    // The addon's controller Deployment is only schedulable once nodes exist.
    ebsCsiAddon.addDependency(eksNodegroup);
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
      roleName: "workshop-risingwave-s3-v2",
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
      // Expire transient scratch prefixes so the bucket doesn't grow unbounded
      // over the platform's lifetime. Athena query results and IoT-error dumps
      // are pure regenerable scratch — left alone they accumulate across every
      // slot until the `autoDeleteObjects` Lambda times out paging them all on
      // `cdk destroy`, leaving the stack DELETE_FAILED (issue #111). Note this
      // does NOT touch `telemetry/` (the Iceberg table data — real workshop
      // output) or per-slot job-doc prefixes; the belt-and-braces teardown fix
      // is emptying the bucket in scripts/sandbox-delete-all.sh before destroy.
      lifecycleRules: [
        {
          id: "expire-athena-results",
          prefix: "athena-results/",
          expiration: Duration.days(7),
        },
        {
          id: "expire-iot-errors",
          prefix: "iot-errors/",
          expiration: Duration.days(14),
        },
        {
          // Abort dangling multipart uploads (a classic silent source of
          // bucket bloat that the auto-delete Lambda must also page through).
          id: "abort-incomplete-mpu",
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
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
    // The Session-5 WAN relay produces to MSK from the edge VPC over the
    // edge↔cloud peering connection (see EdgeCloudPeering above), so admit the
    // edge CIDR on the SASL/SCRAM port too.
    mskSg.addIngressRule(Peer.ipv4(this.edgeVpc.vpcCidrBlock), Port.tcp(9096), "MSK SASL/SCRAM from edge VPC (WAN relay)");

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

    // ── Glue Data Catalog Iceberg table (MSK → Firehose → Iceberg → S3) ─────
    // Pre-provisioned so Firehose has a table to deliver into on first start.
    // Schema/partitioning are chosen to keep the existing Athena queries
    // (workshop/01-observe/block-3-athena.md, workshop/02-control/block-5-observe.md)
    // working unchanged.
    const glueDatabase = new CfnDatabase(this, "TelemetryGlueDatabase", {
      catalogId: this.account,
      databaseInput: {
        name: "workshop_telemetry",
      },
    });

    const icebergWarehousePath = `s3://${workshopBucket.bucketName}/telemetry`;
    const icebergSchemaFields: CfnTable.IcebergStructFieldProperty[] = [
      { id: 1, name: "thing_name", type: "string", required: true },
      { id: 2, name: "message_timestamp", type: "long", required: true },
      { id: 3, name: "cpu_pct", type: "int", required: false },
      { id: 4, name: "mem_used_pct", type: "int", required: false },
      { id: 5, name: "disk_used_pct", type: "int", required: false },
      { id: 6, name: "net_io_bytes_sent", type: "long", required: false },
      { id: 7, name: "net_io_bytes_recv", type: "long", required: false },
      { id: 8, name: "mqtt_topic", type: "string", required: false },
      { id: 9, name: "ingest_ts", type: "long", required: false },
      { id: 10, name: "year", type: "string", required: false },
      { id: 11, name: "month", type: "string", required: false },
      { id: 12, name: "day", type: "string", required: false },
      { id: 13, name: "hour", type: "string", required: false },
      { id: 14, name: "deployment_id", type: "string", required: false },
    ];

    const telemetryIcebergTable = new CfnTable(this, "TelemetryIcebergTable", {
      catalogId: this.account,
      databaseName: glueDatabase.ref,
      // Iceberg tables set the name at the top level, not via `tableInput` —
      // `tableInput` must be entirely absent alongside `openTableFormatInput`,
      // or Glue rejects the create with "Table metadata is expected only via
      // TableInput or via IcebergTableInputProperties inside OpenTableFormatInput".
      name: "telemetry",
      openTableFormatInput: {
        icebergInput: {
          metadataOperation: "CREATE",
          version: "2",
          icebergTableInput: {
            location: `${icebergWarehousePath}/telemetry`,
            schema: {
              fields: icebergSchemaFields,
            },
            // deployment_id first so participants can efficiently query their own data.
            partitionSpec: {
              fields: [
                { sourceId: 14, name: "deployment_id", transform: "identity" },
                { sourceId: 10, name: "year", transform: "identity" },
                { sourceId: 11, name: "month", transform: "identity" },
                { sourceId: 12, name: "day", transform: "identity" },
                { sourceId: 13, name: "hour", transform: "identity" },
              ],
            },
          },
        },
      },
    });
    telemetryIcebergTable.node.addDependency(glueDatabase);

    new CfnOutput(this, "TelemetryGlueDatabaseName", {
      exportName: "workshop-platform-glue-database-name",
      value: glueDatabase.ref,
    });
    new CfnOutput(this, "TelemetryGlueTableName", {
      exportName: "workshop-platform-glue-table-name",
      value: telemetryIcebergTable.ref,
    });

    // ── Firehose (MSK → Iceberg → S3) ────────────────────────────────────────
    // Reads raw.telemetry from MSK via IAM auth, delivers natively to the
    // Iceberg table above via the Glue Data Catalog — no custom code.
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

    const firehoseMskRole = new Role(this, "FirehoseMskRole", {
      assumedBy: new ServicePrincipal("firehose.amazonaws.com"),
    });
    firehoseMskRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "kafka-cluster:Connect",
        "kafka-cluster:DescribeCluster",
        "kafka-cluster:DescribeClusterDynamicConfiguration",
      ],
      resources: [mskCluster.attrArn],
    }));
    firehoseMskRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "kafka-cluster:DescribeTopic",
        "kafka-cluster:DescribeTopicDynamicConfiguration",
        "kafka-cluster:ReadData",
      ],
      resources: [`arn:aws:kafka:${this.region}:${this.account}:topic/workshop-platform-msk/*/*`],
    }));
    firehoseMskRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "kafka-cluster:DescribeGroup",
      ],
      resources: [`arn:aws:kafka:${this.region}:${this.account}:group/workshop-platform-msk/*/*`],
    }));
    firehoseMskRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "ec2:DescribeVpcs",
        "ec2:DescribeSubnets",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeNetworkInterfaces",
      ],
      resources: ["*"],
    }));

    const firehoseDeliveryRole = new Role(this, "FirehoseDeliveryRole", {
      assumedBy: new ServicePrincipal("firehose.amazonaws.com"),
    });
    firehoseDeliveryRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:ListBucketMultipartUploads",
        "s3:AbortMultipartUpload",
        "s3:GetBucketLocation",
      ],
      resources: [workshopBucket.bucketArn, `${workshopBucket.bucketArn}/*`],
    }));
    firehoseDeliveryRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "glue:GetDatabase",
        "glue:GetTable",
        "glue:GetTables",
        "glue:UpdateTable",
      ],
      resources: [
        `arn:aws:glue:${this.region}:${this.account}:catalog`,
        `arn:aws:glue:${this.region}:${this.account}:database/workshop_telemetry`,
        `arn:aws:glue:${this.region}:${this.account}:table/workshop_telemetry/*`,
      ],
    }));
    firehoseDeliveryRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ],
      resources: ["*"],
    }));

    const telemetryFirehoseStream = new CfnDeliveryStream(this, "TelemetryIcebergFirehose", {
      deliveryStreamName: "workshop-telemetry-iceberg",
      deliveryStreamType: "MSKAsSource",
      mskSourceConfiguration: {
        mskClusterArn: mskCluster.attrArn,
        topicName: "raw.telemetry",
        authenticationConfiguration: {
          connectivity: "PRIVATE",
          roleArn: firehoseMskRole.roleArn,
        },
      },
      icebergDestinationConfiguration: {
        roleArn: firehoseDeliveryRole.roleArn,
        catalogConfiguration: {
          catalogArn: `arn:aws:glue:${this.region}:${this.account}:catalog`,
        },
        bufferingHints: {
          intervalInSeconds: 300,
          sizeInMBs: 128,
        },
        destinationTableConfigurationList: [
          {
            destinationDatabaseName: glueDatabase.ref,
            destinationTableName: telemetryIcebergTable.ref,
          },
        ],
        s3Configuration: {
          bucketArn: workshopBucket.bucketArn,
          roleArn: firehoseDeliveryRole.roleArn,
          errorOutputPrefix: "iceberg-errors/",
        },
      },
    });
    telemetryFirehoseStream.node.addDependency(mskBootstrapIamLookup);
    telemetryFirehoseStream.node.addDependency(telemetryIcebergTable);

    new CfnOutput(this, "TelemetryFirehoseStreamName", {
      exportName: "workshop-platform-firehose-stream-name",
      value: telemetryFirehoseStream.ref,
    });

    // ── Athena workgroup ─────────────────────────────────────────────────────
    // Shared across all participant slots. scripts/athena-query.sh defaults to
    // this workgroup (ATHENA_WORKGROUP=workshop-shared).
    const athenaWorkGroup = new CfnWorkGroup(this, "AthenaWorkGroup", {
      name: "workshop-shared",
      // Once the workgroup holds any query-execution history (always, after a
      // participant runs a query), CloudFormation refuses to delete it unless
      // this is set — leaving `cdk destroy` in DELETE_FAILED (issue #111). The
      // per-slot scripts/teardown.sh already passes --recursive-delete-option
      // for the same reason.
      recursiveDeleteOption: true,
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
