import { Stack, StackProps, Duration, CfnOutput } from "aws-cdk-lib";
import {
  Project,
  Source,
  BuildSpec,
  LinuxBuildImage,
  ComputeType,
  BuildEnvironmentVariableType,
} from "aws-cdk-lib/aws-codebuild";
import {
  PolicyStatement,
  Effect,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

export interface OrchestratorStackProps extends StackProps {
  /**
   * GitHub repo the CodeBuild project clones and deploys FROM, as
   * "https://github.com/OWNER/REPO.git". CodeBuild needs a GitHub source
   * credential configured once per account/region (a CodeBuild "source
   * credential" — a PAT or the GitHub App connection); this stack does not
   * create that (it is an account-level singleton), it only references the repo.
   */
  readonly repoCloneUrl: string;
  /** Default branch the orchestrator deploys when none is passed. */
  readonly defaultBranch?: string;
}

/**
 * OrchestratorStack — the cloud-side, fire-and-forget deploy runner (epic #180 /
 * #182).
 *
 * WHAT / WHY:
 * A full workshop deploy (platform + N slots' nested stacks + the per-slot
 * post-deploy tail: device-client build, self-registration wait, K3s +
 * cloud-analytics pre-warm) takes 20-40+ minutes. We do NOT want a GitHub
 * Actions runner (or a facilitator's laptop) blocked for that long. This stack
 * provisions a single CodeBuild project, `workshop-deploy-orchestrator`, that
 * runs `pnpm run sandbox:all <slots>` (i.e. the single `cdk deploy` of
 * WorkshopPlatformStack followed by scripts/post-deploy-slot.sh per slot) via
 * buildspec-deploy.yml.
 *
 * The "async / pollable handle" contract:
 *   - Trigger:  aws codebuild start-build --project-name workshop-deploy-orchestrator
 *               --environment-variables-override name=WORKSHOP_SLOTS,value=ws-slot00,...
 *     returns immediately with a build id (the handle).
 *   - Poll:     aws codebuild batch-get-builds --ids <id>
 *               --query 'builds[0].buildStatus'  (IN_PROGRESS|SUCCEEDED|FAILED)
 *   scripts/trigger-deploy.sh and scripts/poll-deploy.sh wrap these.
 *
 * IDEMPOTENT: `cdk deploy` is idempotent and sandbox:all unions the requested
 * slots into the persisted active-slot set (scripts/slot-list.sh), so a re-run
 * never tears down slots it wasn't asked about. concurrentBuildLimit=1 serializes
 * builds so two can't race the same CloudFormation stack.
 *
 * The CodeBuild role is intentionally broad (admin-equivalent) because the deploy
 * it runs creates VPCs, EKS, MSK, IAM, IoT, Firehose, S3 — essentially the whole
 * account footprint. This is the same blast radius a facilitator's local
 * credentials already have; the trade-off is documented in
 * workshop/reference/decisions.
 */
export class OrchestratorStack extends Stack {
  public readonly project: Project;

  constructor(scope: Construct, id: string, props: OrchestratorStackProps) {
    super(scope, id, props);

    const defaultBranch = props.defaultBranch ?? "main";

    // Explicit CodeBuild service role so its ARN is deterministic at synth time.
    // We need the ARN in two places: to grant it (below) and to hand it to the
    // deploy as WORKSHOP_EKS_ADMIN_PRINCIPAL_ARNS so the platform `cdk deploy`
    // adds a cluster-scoped EKS access entry (CfnAccessEntry) for this very role
    // BEFORE the post-deploy tail runs kubectl/helm against workshop-eks (#223).
    // IAM admin (granted below) lets `aws eks update-kubeconfig` succeed, but EKS
    // Kubernetes RBAC is separate — without an access entry every kubectl call in
    // deploy-cloud-analytics.sh 401s ("server has asked for credentials").
    const buildRole = new Role(this, "DeployOrchestratorRole", {
      assumedBy: new ServicePrincipal("codebuild.amazonaws.com"),
      description:
        "Service role for the workshop-deploy-orchestrator CodeBuild project (epic #182). Admin-equivalent; also mapped as an EKS cluster admin via CfnAccessEntry (#223).",
    });

    this.project = new Project(this, "DeployOrchestrator", {
      role: buildRole,
      projectName: "workshop-deploy-orchestrator",
      description:
        "Fire-and-forget deploy of WorkshopPlatformStack + slot nested stacks (epic #182).",
      // Clone the repo directly; the branch/commit is chosen per-build via
      // start-build --source-version, so a dispatch from any branch deploys that
      // branch's code without editing the project.
      source: Source.gitHub({
        // Parse OWNER/REPO out of the clone URL for the L2 source.
        owner: ownerFromCloneUrl(props.repoCloneUrl),
        repo: repoFromCloneUrl(props.repoCloneUrl),
      }),
      buildSpec: BuildSpec.fromSourceFilename("buildspec-deploy.yml"),
      environment: {
        // Standard 7.0 image has Node, pnpm-via-corepack, Docker.
        buildImage: LinuxBuildImage.STANDARD_7_0,
        computeType: ComputeType.MEDIUM,
        // sandbox.sh builds the IoT Device Client in a Docker container.
        privileged: true,
      },
      environmentVariables: {
        WORKSHOP_SLOTS: {
          type: BuildEnvironmentVariableType.PLAINTEXT,
          value: "",
        },
        // platform-app.ts reads this (csvContext) and adds a cluster-scoped EKS
        // access entry for the deploy runner, so the post-deploy tail's kubectl/
        // helm steps can reach workshop-eks (#223). Its own role ARN — resolved
        // at synth from the explicit role above.
        WORKSHOP_EKS_ADMIN_PRINCIPAL_ARNS: {
          type: BuildEnvironmentVariableType.PLAINTEXT,
          value: buildRole.roleArn,
        },
      },
      // Serialize: two concurrent deploys would race the same CloudFormation
      // stack. A second dispatch waits (or fails fast) rather than corrupting
      // the shared stack.
      concurrentBuildLimit: 1,
      timeout: Duration.hours(2),
    });

    // The deploy touches essentially the whole account (VPC/EKS/MSK/IAM/IoT/
    // Firehose/S3/CloudFormation/SSM/Secrets/Athena/Glue). Grant admin — same
    // blast radius as a facilitator's own credentials. Tightening this to a
    // least-privilege policy is tracked as follow-up (see decisions doc).
    buildRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["*"],
        resources: ["*"],
      })
    );

    new CfnOutput(this, "OrchestratorProjectName", {
      value: this.project.projectName,
      description: "CodeBuild project name — pass to `aws codebuild start-build`.",
      exportName: "workshop-deploy-orchestrator-project",
    });
    new CfnOutput(this, "OrchestratorDefaultBranch", {
      value: defaultBranch,
      description: "Branch deployed when start-build is called without --source-version.",
    });
  }
}

function ownerFromCloneUrl(url: string): string {
  // https://github.com/OWNER/REPO(.git)?
  const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) throw new Error(`Cannot parse GitHub owner from clone url: ${url}`);
  return m[1];
}

function repoFromCloneUrl(url: string): string {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) throw new Error(`Cannot parse GitHub repo from clone url: ${url}`);
  return m[2];
}
