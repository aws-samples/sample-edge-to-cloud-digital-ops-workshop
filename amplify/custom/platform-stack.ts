import { Stack, StackProps, CfnOutput, CfnDeletionPolicy } from "aws-cdk-lib";
import {
  Vpc,
  SubnetType,
  GatewayVpcEndpointAwsService,
  IpAddresses,
  SecurityGroup,
} from "aws-cdk-lib/aws-ec2";
import {
  Role,
  ServicePrincipal,
  ManagedPolicy,
} from "aws-cdk-lib/aws-iam";
import {
  CfnCluster as EksCfnCluster,
  CfnNodegroup,
} from "aws-cdk-lib/aws-eks";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

export interface PlatformStackProps extends StackProps {}

/**
 * Shared platform infrastructure — deployed once per account/region.
 *
 * workshop-edge  10.0.0.0/16  — edge EC2 instances, isolated /24 subnets per slot
 * workshop-cloud 10.1.0.0/16  — shared EKS cluster, per-slot MSK clusters
 *
 * EKS cluster is shared across all participants. Each participant slot gets its
 * own namespace (e.g. ws-slot00) with RBAC scoped to that namespace.
 */
export class PlatformStack extends Stack {
  public readonly edgeVpc: Vpc;
  public readonly cloudVpc: Vpc;

  constructor(scope: Construct, id: string, props?: PlatformStackProps) {
    super(scope, id, props);

    // Edge VPC: public subnets only, 10.0.0.0/16.
    // Each participant slot gets one /24 added by ParticipantStack.
    // The VPC-level route table has an IGW entry; per-subnet isolation is
    // enforced by the subnet route tables written in ParticipantStack.
    this.edgeVpc = new Vpc(this, "WorkshopEdgeVpc", {
      vpcName: "workshop-edge",
      ipAddresses: IpAddresses.cidr("10.0.0.0/16"),
      maxAzs: 3,
      natGateways: 0,
      subnetConfiguration: [], // Participant stacks add their own subnets
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
    // Retain on stack delete — manual cleanup prevents accidental data loss.
    eksCluster.cfnOptions.deletionPolicy = CfnDeletionPolicy.RETAIN;

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
    eksNodegroup.cfnOptions.deletionPolicy = CfnDeletionPolicy.RETAIN;

    new CfnOutput(this, "EksClusterName", {
      exportName: "workshop-eks-cluster-name",
      value: eksCluster.ref,
      description: "Run: aws eks update-kubeconfig --name workshop-eks to configure kubectl",
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
              namedShadowNames: ["device-health", "device-config", "app-deployment"],
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
              namedShadowNames: ["device-health", "device-config", "app-deployment"],
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
