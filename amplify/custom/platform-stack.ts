import { Stack, StackProps } from "aws-cdk-lib";
import {
  Vpc,
  SubnetType,
  GatewayVpcEndpointAwsService,
  IpAddresses,
  IVpc,
} from "aws-cdk-lib/aws-ec2";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

export interface PlatformStackProps extends StackProps {}

/**
 * Creates two shared VPCs used across all participant slots.
 * Checked-for-existence at deploy time via CDK context; only one set of VPCs
 * is created regardless of how many participant stacks are deployed.
 *
 * workshop-edge  10.0.0.0/16  — edge EC2 instances, isolated /24 subnets per slot
 * workshop-cloud 10.1.0.0/16  — EKS cluster, MSK cluster
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
