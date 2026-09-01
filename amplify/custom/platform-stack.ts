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
import { LogGroup, LogStream, RetentionDays } from "aws-cdk-lib/aws-logs";
import { CfnDatabase, CfnTable } from "aws-cdk-lib/aws-glue";
import { CfnWorkGroup } from "aws-cdk-lib/aws-athena";
import { CfnInfluxDBInstance } from "aws-cdk-lib/aws-timestream";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
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

  /**
   * Initial node count for the dedicated `rw-compute` node group. One
   * `r6i.xlarge` node fits exactly one slot's RisingWave compute pod (each
   * requests ~2 vCPU and can only land here via the `workload:
   * risingwave-compute` selector + `dedicated` taint toleration), so a deploy
   * must provision at least one node per active slot or the 2nd+ slot's
   * compute pod sits Pending forever — and its DDL/MVs then can't be created
   * (#214/#215). There is no cluster-autoscaler on this cluster, so
   * `desiredSize` is the only lever; platform-app.ts drives it from the number
   * of slots being deployed (`max(1, slotCount)`). Defaults to 1 (zero-slot /
   * shared-infra-only deploys still keep one warm node). Capped by the node
   * group's `maxSize` (8).
   */
  readonly rwComputeDesiredSize?: number;
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

  /**
   * Shared-platform values consumed by each per-slot ParticipantStack nested
   * stack (see #181). Exposed as live construct references so that when
   * platform-app.ts instantiates the nested stacks, CDK wires them in as
   * parent→child CfnParameters — the correct replacement for the old
   * `Fn.importValue` cross-stack imports, which a nested stack cannot use
   * against its own still-in-progress parent's exports.
   */
  public readonly shared: {
    bucketName: string;
    bucketArn: string;
    mskClusterArn: string;
    mskBootstrapScram: string;
    mskScramKeyArn: string;
    edgeNatGatewayId: string;
    influxEndpoint: string;
    influxAdminSecretArn: string;
    influxOrg: string;
  };

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

    // ── Dedicated RisingWave-compute node group (#211) ──────────────────────
    // Fixes the persistent ~10s steady-state RisingWave freshness lag AND the
    // RW now()/MV-epoch clock skew (#206) — both were the same root cause:
    // CPU starvation. On the shared burstable workshop-nodes t3.medium, the RW
    // compute pod was CFS-throttled ~10-29% of scheduling periods, which
    // starved the barrier/epoch commit path and dragged RisingWave's internal
    // watermark clock behind wall-clock (that skew *is* the freshness number).
    // Proven live on ws-slot90: dedicated r6i.xlarge (non-burstable, so no CPU
    // credit exhaustion) dropped throttling to 0.58%, freshness to ~2.3s avg,
    // and the now() skew to ~1.5s.
    //
    // Shared-vs-per-slot: ONE shared node group for the whole cluster (not one
    // per slot), matching workshop-nodes above. Isolation between slots' RW
    // compute pods isn't the problem this fixes — CPU starvation from sharing
    // with unrelated pods (TimescaleDB, dashboard, etc.) on a burstable
    // instance is. A dedicated per-slot node group would multiply the r6i.xlarge
    // cost by the slot count for no freshness benefit, since the taint already
    // keeps every non-RW-compute pod off these nodes regardless of how many
    // slots share the pool. Helm's nodeSelector/toleration (see
    // helm/cloud-analytics) target this pool's label so every slot's RW
    // compute lands here; the node group scales (desiredSize→maxSize) as more
    // slots' compute pods need to schedule.
    //
    // r6i.xlarge (4 vCPU / 32 GiB, memory-optimized, non-burstable) sized to
    // match the live-validated compute.resources: request ~4 GiB/2 vCPU so a
    // slot's compute pod comfortably fits one node, limit 24 GiB/3.5 vCPU for
    // burst headroom (startup backfill, Hummock block cache) while leaving
    // allocatable margin below the node's ~31 GiB/~3.9 vCPU allocatable.
    const rwComputeNodegroup = new CfnNodegroup(this, "RwComputeNodegroup", {
      clusterName: eksCluster.ref,
      nodegroupName: "rw-compute",
      nodeRole: eksNodeRole.roleArn,
      subnets: this.cloudVpc.selectSubnets({ subnetType: SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
      instanceTypes: ["r6i.xlarge"],
      scalingConfig: {
        minSize: 1,
        maxSize: 8,
        // Driven by the active-slot count (see platform-app.ts): one r6i.xlarge
        // fits exactly one slot's RW compute pod and there's no autoscaler, so
        // a deploy must provision one node per slot up front or the 2nd+ slot's
        // compute stays Pending (#215). Clamped to [1, maxSize].
        desiredSize: Math.min(8, Math.max(1, props?.rwComputeDesiredSize ?? 1)),
      },
      amiType: "AL2_x86_64",
      diskSize: 20,
      labels: {
        workload: "risingwave-compute",
      },
      taints: [
        {
          key: "dedicated",
          value: "risingwave-compute",
          effect: "NO_SCHEDULE",
        },
      ],
    });
    rwComputeNodegroup.addDependency(eksCluster);

    new CfnOutput(this, "EksClusterName", {
      exportName: "workshop-eks-cluster-name",
      value: eksCluster.ref,
      description: "Run: aws eks update-kubeconfig --name workshop-eks to configure kubectl",
    });

    // Cluster-scoped access entries for admin/CI principals. `accessConfig.
    // bootstrapClusterCreatorAdminPermissions` only grants admin to whoever ran
    // the very first `cdk deploy` — every other principal (a re-run CI role, the
    // async deploy orchestrator's CodeBuild role, a second facilitator) is
    // invisible to the cluster's RBAC until explicitly added here.
    //
    // Must be AmazonEKSClusterAdminPolicy, NOT AmazonEKSAdminPolicy (#225):
    // AmazonEKSAdminPolicy maps to the built-in `admin` ClusterRole, which — even
    // bound cluster-wide — CANNOT create namespaces (a cluster-scoped resource)
    // or install CRDs/ClusterRoles. The deploy these principals run does exactly
    // that: deploy-cloud-analytics.sh / block-1-deploy.md `kubectl create
    // namespace`, install cert-manager + risingwave-operator + cnpg (all ship
    // CRDs and cluster roles), and apply a gp3 StorageClass. Those need
    // cluster-admin. The cluster creator gets it implicitly via the bootstrap
    // flag; access-entry principals need it granted explicitly.
    (props?.eksAdminPrincipalArns ?? []).forEach((principalArn, i) => {
      const accessEntry = new CfnAccessEntry(this, `EksAdminAccessEntry${i}`, {
        clusterName: eksCluster.ref,
        principalArn,
        type: "STANDARD",
        accessPolicies: [
          {
            policyArn:
              "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy",
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

    // ── Cloud-analytics dashboard IRSA role (AppSync Events live-push tier) ────
    // The shared cloud-analytics dashboard (#253 — one instance for every slot)
    // subscribes to each slot's per-slot AppSync Events API to render the
    // "no storage" freshness leg. Its `cloud-analytics-dashboard` ServiceAccount
    // assumes this role via IRSA so the pod can (a) read each slot's Events API
    // endpoint from SSM and (b) connect + subscribe to the realtime WebSocket
    // with SigV4 — never handing AWS credentials to the browser. The Events APIs
    // live in the per-slot ParticipantStacks (created after this shared stack),
    // so the resource ARNs are wildcarded rather than cross-stack referenced.
    const dashboardAudCondition = new CfnJson(this, "DashboardAudCondition", {
      value: { [`${oidcProviderHost}:aud`]: "sts.amazonaws.com" },
    });
    const dashboardSubCondition = new CfnJson(this, "DashboardSubCondition", {
      value: {
        [`${oidcProviderHost}:sub`]:
          "system:serviceaccount:*:cloud-analytics-dashboard",
      },
    });
    const dashboardRole = new Role(this, "CloudDashboardRole", {
      roleName: "workshop-cloud-dashboard-v1",
      assumedBy: new FederatedPrincipal(
        eksOidcProvider.openIdConnectProviderArn,
        {
          StringEquals: dashboardAudCondition,
          StringLike: dashboardSubCondition,
        } as unknown as Conditions,
        "sts:AssumeRoleWithWebIdentity"
      ),
    });
    // Connect + subscribe to any slot's Events API (the shared dashboard serves
    // every slot; EventConnect is on the API, EventSubscribe on its namespaces).
    dashboardRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["appsync:EventConnect", "appsync:EventSubscribe"],
      resources: [
        `arn:aws:appsync:${this.region}:${this.account}:apis/*`,
        `arn:aws:appsync:${this.region}:${this.account}:apis/*/channelNamespace/*`,
      ],
    }));
    // Read each slot's `/workshop/<id>/events-api-endpoint` SSM parameter.
    dashboardRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["ssm:GetParameter"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/workshop/*`],
    }));

    new CfnOutput(this, "CloudDashboardRoleArn", {
      exportName: "workshop-platform-cloud-dashboard-role-arn",
      value: dashboardRole.roleArn,
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
        // Firehose reaches the cluster over PrivateLink (MSKAsSource, PRIVATE
        // connectivity), which requires multi-VPC private connectivity enabled
        // for the IAM auth scheme. In the AWS::MSK::Cluster schema this lives
        // under BrokerNodeGroupInfo.connectivityInfo (NOT a top-level property).
        // Toggling it on the existing cluster triggers a rolling broker reboot
        // (~30 min); SASL/IAM data-plane clients are unaffected. Paired with the
        // CfnClusterPolicy below granting Firehose CreateVpcConnection.
        connectivityInfo: {
          vpcConnectivity: {
            clientAuthentication: {
              sasl: {
                iam: {
                  enabled: true,
                },
              },
            },
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

    // ── Shared Amazon Timestream for InfluxDB instance (#229/#233) ───────────
    // A managed hot-storage tier placed next to the self-managed TimescaleDB, so
    // the Session-4 freshness comparison can show AWS-managed vs self-managed.
    // ONE shared instance (per-slot *bucket*, provisioned in-cluster by #230 —
    // the instance is private, so bucket/token minting runs from inside the
    // cloud VPC, not from the deploy script). Mirrors the MSK precedent: shared
    // infra here, per-slot isolation via naming.
    const influxSg = new SecurityGroup(this, "InfluxSg", {
      vpc: this.cloudVpc,
      description: "workshop-influxdb shared instance",
      allowAllOutbound: true,
    });
    // EKS-managed node groups (no launch template) attach the auto-created EKS
    // cluster SG, not a construct handle we hold — so, exactly as MSK does above,
    // admit the whole cloud VPC CIDR on the InfluxDB port rather than a source SG.
    influxSg.addIngressRule(
      Peer.ipv4(this.cloudVpc.vpcCidrBlock),
      Port.tcp(8086),
      "InfluxDB HTTP API from cloud VPC (EKS pods: Telegraf sink + dashboard)",
    );

    // Admin credentials. Timestream for InfluxDB stores {organization, bucket,
    // username, password} in an auto-created secret (attrInfluxAuthParametersSecretArn),
    // but we also need to *supply* the password at create time — so generate one
    // here and expose THIS secret (deterministic name, we control its contents).
    // Default (AWS-managed) Secrets Manager encryption on purpose: the deploy
    // script reads it with plain secretsmanager:GetSecretValue, avoiding the
    // kms:Decrypt / CreateGrant IAM races a CMK would add (see #102, #123 notes).
    const influxOrg = "workshop";
    const influxAdminSecret = new Secret(this, "InfluxAdminSecret", {
      secretName: "workshop-platform-influxdb-admin",
      description: "Timestream for InfluxDB shared admin credentials (username/password)",
      removalPolicy: RemovalPolicy.DESTROY,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "workshopadmin", organization: influxOrg }),
        generateStringKey: "password",
        // InfluxDB admin password: >= 8 chars; keep it punctuation-free so it is
        // safe to pass through shell/env in the in-cluster provisioning job.
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    // --8<-- [start:influxdb-instance]
    const influxInstance = new CfnInfluxDBInstance(this, "InfluxDbInstance", {
      name: "workshop-influxdb",
      dbInstanceType: "db.influx.medium",
      allocatedStorage: 20,
      dbStorageType: "InfluxIOIncludedT1",
      deploymentType: "SINGLE_AZ", // production HA (WITH_MULTIAZ_STANDBY) is a documented knob; off for cost
      networkType: "IPV4",
      port: 8086,
      publiclyAccessible: false,
      organization: influxOrg,
      bucket: "workshop-init", // initial bucket; per-slot buckets are created in-cluster (#230)
      username: "workshopadmin",
      password: influxAdminSecret.secretValueFromJson("password").unsafeUnwrap(),
      vpcSecurityGroupIds: [influxSg.securityGroupId],
      vpcSubnetIds: this.cloudVpc.selectSubnets({ subnetType: SubnetType.PRIVATE_WITH_EGRESS }).subnetIds.slice(0, 1),
    });
    // --8<-- [end:influxdb-instance]
    // Let `cdk destroy` (sandbox:delete-all) cascade cleanly.
    influxInstance.applyRemovalPolicy(RemovalPolicy.DESTROY);

    // Exposed as CFN exports (list-exports) so scripts/deploy-cloud-analytics.sh
    // resolves them the same way it resolves the MSK ARN — the endpoint is the
    // bare host; consumers connect on https://<endpoint>:8086.
    new CfnOutput(this, "InfluxDbEndpoint", {
      exportName: "workshop-platform-influxdb-endpoint",
      value: influxInstance.attrEndpoint,
    });
    new CfnOutput(this, "InfluxDbAdminSecretArn", {
      exportName: "workshop-platform-influxdb-admin-secret-arn",
      value: influxAdminSecret.secretArn,
    });
    new CfnOutput(this, "InfluxDbOrg", {
      exportName: "workshop-platform-influxdb-org",
      value: influxOrg,
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

    // ⚠️ INVARIANT — DO NOT CHANGE THIS PATH (or the `/telemetry` suffix on the
    // table `location` below) on an account that already has data.
    //
    // The Iceberg table `location` is the physical prefix its data files are
    // written under. Iceberg snapshots reference data files by ABSOLUTE path, so
    // changing the location does NOT move or re-home existing files — it only
    // redirects NEW writes. Every prior data file stays referenced by the live
    // snapshot chain at its OLD path. If those old files are then deleted (e.g.
    // a teardown/cleanup of the "stale" prefix), the table's manifests dangle and
    // EVERY Athena query fails with ICEBERG_CANNOT_OPEN_SPLIT.
    //
    // This is exactly what PR #163 caused: it changed this from
    // `s3://<bucket>/telemetry` → `s3://<bucket>` (collapsing the doubled
    // `telemetry/telemetry` prefix). New data went to `telemetry/data/`, but
    // ~6k files remained referenced at the deleted `telemetry/telemetry/data/`
    // path, breaking the shared table for all slots. Recovery required dropping
    // and recreating the table.
    //
    // If the location EVER must change, it is a data migration, not a config
    // edit: recreate the table at the new location and re-register (or re-ingest)
    // the data — never just edit the string and redeploy.
    const icebergWarehousePath = `s3://${workshopBucket.bucketName}`;
    const icebergSchemaFields: CfnTable.IcebergStructFieldProperty[] = [
      { id: 1, name: "thing_name", type: "string", required: true },
      { id: 2, name: "message_timestamp", type: "long", required: true },
      { id: 3, name: "cpu_pct", type: "double", required: false },
      { id: 4, name: "mem_used_pct", type: "double", required: false },
      { id: 5, name: "disk_used_pct", type: "double", required: false },
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
              // Iceberg's REST CreateTableRequest parser requires the top-level
              // struct discriminator; without `type: "struct"` Glue rejects the
              // create with "Cannot parse type from json ... CreateTableRequest[schema]".
              type: "struct",
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

    // ── Firehose (DirectPut → Iceberg → S3) ──────────────────────────────────
    // Records are written to the stream via the Firehose PutRecord/PutRecordBatch
    // API and delivered natively to the Iceberg table above via the Glue Data
    // Catalog — no custom code.
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

    // CloudWatch logging for the delivery stream — surfaces per-record Iceberg
    // delivery errors (e.g. schema/parse failures) that are otherwise invisible:
    // Firehose can drop records that never reach the S3 error prefix and emit no
    // failure metric. The log group/stream names are the shape Firehose expects.
    const firehoseLogGroup = new LogGroup(this, "TelemetryFirehoseLogGroup", {
      logGroupName: "/aws/kinesisfirehose/workshop-telemetry-iceberg-direct",
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const firehoseLogStream = new LogStream(this, "TelemetryFirehoseLogStream", {
      logGroup: firehoseLogGroup,
      logStreamName: "IcebergDelivery",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const telemetryFirehoseStream = new CfnDeliveryStream(this, "TelemetryIcebergFirehose", {
      // Renamed from the retired MSKAsSource stream (workshop-telemetry-iceberg):
      // switching deliveryStreamType forces a replacement, and CFN refuses to
      // replace a custom-named resource in place unless the name also changes.
      deliveryStreamName: "workshop-telemetry-iceberg-direct",
      deliveryStreamType: "DirectPut",
      icebergDestinationConfiguration: {
        roleArn: firehoseDeliveryRole.roleArn,
        catalogConfiguration: {
          catalogArn: `arn:aws:glue:${this.region}:${this.account}:catalog`,
        },
        bufferingHints: {
          intervalInSeconds: 300,
          sizeInMBs: 128,
        },
        cloudWatchLoggingOptions: {
          enabled: true,
          logGroupName: firehoseLogGroup.logGroupName,
          logStreamName: firehoseLogStream.logStreamName,
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
    telemetryFirehoseStream.node.addDependency(firehoseLogStream);
    // The Iceberg table must exist before the delivery stream targets it.
    telemetryFirehoseStream.node.addDependency(telemetryIcebergTable);
    telemetryFirehoseStream.node.addDependency(firehoseDeliveryRole);

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

    // ── IoT Jobs → reserved $package shadow auto-update ──────────────────────
    // Role IoT Jobs assumes to write the reserved named shadow ($package) when a
    // job with destinationPackageVersions completes successfully. Enabled
    // account-wide via the PackageConfig custom resource below. Account-wide, so
    // it lives in PlatformStack (one role covers all slots), mirroring
    // FleetIndexingConfig. Thing names are EC2 instance IDs (not slot-prefixed)
    // and carry no tags, so the shadow resource can't be scoped tighter than
    // thing/* — consistent with the participant role's IoT scoping rationale.
    const iotJobsShadowUpdateRole = new Role(this, "IotJobsShadowUpdateRole", {
      assumedBy: new ServicePrincipal("iot.amazonaws.com"),
      description: "Lets IoT Jobs update the reserved $package named shadow on job success",
    });
    iotJobsShadowUpdateRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["iot:UpdateThingShadow", "iot:GetThingShadow"],
      resources: [`arn:aws:iot:${this.region}:${this.account}:thing/*`],
    }));
    // The IoT Jobs service resolves the data-plane endpoint via DescribeEndpoint
    // before writing the shadow; without it the $package write silently no-ops
    // (the job still reports SUCCEEDED, but the shadow is never created). This
    // mirrors the console-generated `aws-iot-role-update-shadows` role, which
    // grants iot:DescribeEndpoint on "*" alongside the shadow permissions.
    iotJobsShadowUpdateRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["iot:DescribeEndpoint"],
      resources: ["*"],
    }));

    // Enable IoT Jobs → $package shadow reporting account-wide. Once enabled, a
    // job whose destinationPackageVersions is set updates the thing's reserved
    // $package shadow automatically on success — so job handlers must NOT also
    // hand-write $package (AWS warns this causes version inconsistencies).
    // Account-wide setting, one custom resource for all slots (like
    // FleetIndexingConfig below).
    const packageConfig = new AwsCustomResource(this, "PackageConfig", {
      onCreate: {
        service: "Iot",
        action: "updatePackageConfiguration",
        parameters: {
          versionUpdateByJobsConfig: {
            enabled: true,
            roleArn: iotJobsShadowUpdateRole.roleArn,
          },
        },
        physicalResourceId: PhysicalResourceId.of("PackageConfig"),
      },
      onUpdate: {
        service: "Iot",
        action: "updatePackageConfiguration",
        parameters: {
          versionUpdateByJobsConfig: {
            enabled: true,
            roleArn: iotJobsShadowUpdateRole.roleArn,
          },
        },
        physicalResourceId: PhysicalResourceId.of("PackageConfig"),
      },
      // No onDelete: versionUpdateByJobsConfig is account-wide and not part of
      // routine slot teardown; leaving it enabled is harmless (no effect until a
      // job sets destinationPackageVersions).
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });
    // updatePackageConfiguration validates the role can be assumed by IoT →
    // ensure the role exists first.
    packageConfig.node.addDependency(iotJobsShadowUpdateRole);
    // fromSdkCalls(ANY_RESOURCE) covers iot:updatePackageConfiguration, but
    // passing a role to a service additionally requires iam:PassRole.
    packageConfig.grantPrincipal.addToPrincipalPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["iam:PassRole"],
      resources: [iotJobsShadowUpdateRole.roleArn],
    }));

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

    // ── Shared values for per-slot nested ParticipantStacks (#181) ────────────
    // Live construct references (not Fn.importValue): platform-app.ts passes
    // these into each ParticipantStack, and CDK turns cross-stack references
    // into nested-stack CfnParameters, preserving correct create ordering.
    this.shared = {
      bucketName: workshopBucket.bucketName,
      bucketArn: workshopBucket.bucketArn,
      mskClusterArn: mskCluster.attrArn,
      mskBootstrapScram: mskBootstrapLookup.getResponseField("BootstrapBrokerStringSaslScram"),
      mskScramKeyArn: mskScramKey.keyArn,
      edgeNatGatewayId: edgeNatGateway.ref,
      influxEndpoint: influxInstance.attrEndpoint,
      influxAdminSecretArn: influxAdminSecret.secretArn,
      influxOrg,
    };
  }
}
