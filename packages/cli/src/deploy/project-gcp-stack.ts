import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { VertexLocation } from '@indx-workspace/contracts/models';
import type { ProductionEnvironment, ProductionGcp } from '@indx-workspace/contracts/project-file';

import { parseEnvironment, resolveDeploymentImages, type DeploymentImages } from '../deployment.ts';
import { type DeploymentProfile } from '../profile.ts';
import { runRenderCommand } from '../render.ts';
import {
  applyDatabase,
  applyFoundation,
  backendFor,
  copyWhileCreatingDatabase,
  deployRerunCommand,
  ensureStateBucket,
  expectedImageRegistry,
  holdsDatabase,
  initialiseBackend,
  lifecycleStep,
  moduleResourceName,
  oidcClientSecretId,
  planCreatesWeb,
  readAppUrls,
  readOwnerPassword,
  readTerraformOutput,
  seedVertexConnection,
  showPlanSummary,
  stateBucketName,
  storeOidcClientSecret,
  writeProjectVariables,
} from './gcp-lifecycle.ts';
import { cloudRunImages, copiedApps, withCopiedImages } from './project-cloudrun-images.ts';
import { fetchOption } from './project-prerequisites.ts';
import { syncDeploymentState } from './project-state.ts';
import {
  type CloudRunModule,
  type DeployedState,
  type DeployProjectEnvironmentOptions,
} from './project-types.ts';
import { createRedactor } from './redact.ts';
import { spawnTool } from './runner.ts';
import type { DeployContext } from './steps.ts';
import { selectTarget } from './targets.ts';
import { deployWithTerraform } from './terraform.ts';

/** What the gcp lifecycle returns beyond a deploy outcome: the web address, once there is one. */
export interface GcpStackState extends DeployedState {
  readonly webUrl: string | null;
  /** `terraform output -raw load_balancer_ip`, once a load balancer exists. */
  readonly loadBalancerIp: string | null;
  /** `terraform output -json app_urls`: app name → run.app URL; empty before the apps are up. */
  readonly appUrls?: Readonly<Record<string, string>>;
  /** The location of the Vertex AI connection this run seeded; `null` when it seeded none. */
  readonly seededLocation?: VertexLocation | null;
}

/**
 * `aw deploy production` for a project with `environments.production.gcp` and no `--infra`: from
 * an empty state to a running stack with no manual Terraform or gcloud step. The order is the
 * contract: variables, state bucket, init, state, a first apply of the APIs and image repository,
 * the image copy (with `apply` and no Cloud SQL instance in the state yet, a targeted apply creates
 * it meanwhile), then the full plan and apply. Without `apply` it creates nothing in Google Cloud.
 */
interface GcpDeployment {
  readonly options: DeployProjectEnvironmentOptions;
  readonly deployed: ProductionEnvironment;
  readonly gcp: ProductionGcp;
  readonly profile: DeploymentProfile;
  readonly cloudRunModule: CloudRunModule;
  readonly created: boolean;
  readonly base: DeployContext;
}

type TerraformTarget = Extract<import('./targets.ts').DeployTarget, { readonly kind: 'terraform' }>;

export async function deployGcpStack(deployment: GcpDeployment): Promise<GcpStackState> {
  const { options, profile, cloudRunModule, base } = deployment;
  const { apply, stateDirectory } = options;
  const { moduleDirectory } = cloudRunModule;
  const adminEmail = profile.identity.bootstrapAdmin;
  const envFile = path.join(stateDirectory, '.env');
  if (!(await initialiseManagedStack(deployment))) {
    return {
      changes: true,
      applied: false,
      created: false,
      adminEmail,
      envFile,
      moduleDirectory,
      webUrl: null,
      loadBalancerIp: null,
    };
  }
  const target = await prepareManagedTarget(deployment);
  if (apply && (await readTerraformOutput(base, moduleDirectory, 'image_registry')) === null) {
    await lifecycleStep(
      base,
      'Enable the APIs and create the image repository',
      (context) => applyFoundation(context, moduleDirectory, target.variablesFile),
      { rerun: deployRerunCommand(apply) },
    );
  }
  const oidcSecret = await prepareSignIn(deployment, target);
  const toolEnvironment = await prepareStackImages(deployment, target);
  return applyManagedStack(deployment, target, { oidcSecret, toolEnvironment });
}

async function initialiseManagedStack(deployment: GcpDeployment): Promise<boolean> {
  const { options, gcp, cloudRunModule, base } = deployment;
  const { project, apply } = options;
  const { moduleDirectory } = cloudRunModule;
  const env = options.env ?? process.env;
  const resourceName = moduleResourceName(project.name);
  await writeProjectVariables(moduleDirectory, gcp, resourceName, env);
  const rerun = { rerun: deployRerunCommand(apply) };
  const bucket = await lifecycleStep(
    base,
    'Check the Terraform state bucket',
    (context) => ensureStateBucket(context, gcp, apply),
    rerun,
  );
  if (bucket === 'missing') {
    base.out(
      `The Terraform state bucket gs://${stateBucketName(gcp)} does not exist yet. ` +
        'Re-run with --yes to create it and deploy; nothing was created.\n',
    );
    return false;
  }
  await lifecycleStep(
    base,
    'Initialise Terraform',
    (context) => initialiseBackend(context, moduleDirectory, backendFor(gcp, project.name)),
    rerun,
  );

  return true;
}

async function prepareManagedTarget(deployment: GcpDeployment): Promise<TerraformTarget> {
  const { options, deployed, profile, cloudRunModule, created } = deployment;
  const { stateDirectory } = options;
  const { infra } = cloudRunModule;
  const env = options.env ?? process.env;
  const initial = (): DeploymentImages => options.images ?? resolveDeploymentImages('gcp', env);
  await syncDeploymentState(options, deployed, profile, { created, images: initial });
  await renderStack(options, env);
  const target = selectTarget({
    profile,
    images: initial(),
    requested: null,
    projectDirectory: stateDirectory,
    infraDirectory: infra,
  });
  if (target.kind !== 'terraform') throw new Error('The gcp-cloudrun target is not Terraform.');

  return target;
}

async function renderStack(
  options: DeployProjectEnvironmentOptions,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  await runRenderCommand([options.stateDirectory], {
    environment,
    out: () => undefined,
    err: (text) => void process.stderr.write(createRedactor({})(text)),
  });
}

async function prepareSignIn(
  deployment: GcpDeployment,
  target: TerraformTarget,
): Promise<string | null> {
  const { options, gcp, cloudRunModule, base } = deployment;
  const { project, apply } = options;
  const { moduleDirectory } = cloudRunModule;
  const env = options.env ?? process.env;
  const resourceName = moduleResourceName(project.name);
  const rerun = { rerun: deployRerunCommand(apply) };
  let oidcSecret: string | null = null;
  const { oidc } = gcp;
  if (oidc !== undefined && !apply) {
    base.out(
      `Sign-in: ${deployRerunCommand(true)} asks once for the client secret of ` +
        `${oidc.issuer} and keeps it in Secret Manager.\n`,
    );
  } else if (oidc !== undefined) {
    oidcSecret = await lifecycleStep(
      base,
      'Store the sign-in client secret',
      (context) =>
        storeOidcClientSecret(context, {
          moduleDirectory,
          variablesFile: target.variablesFile,
          project: gcp.project,
          secretId: oidcClientSecretId(resourceName),
          oidc,
          env,
          ...(options.readSecret === undefined ? {} : { readSecret: options.readSecret }),
        }),
      rerun,
    );
  }
  return oidcSecret;
}

async function prepareStackImages(
  deployment: GcpDeployment,
  target: TerraformTarget,
): Promise<NodeJS.ProcessEnv> {
  const { options, deployed, gcp, profile, cloudRunModule, base } = deployment;
  const { project, apply, stateDirectory } = options;
  const { moduleDirectory } = cloudRunModule;
  const adminEmail = profile.identity.bootstrapAdmin;
  const envFile = path.join(stateDirectory, '.env');
  const resourceName = moduleResourceName(project.name);
  const env = options.env ?? process.env;
  const rerun = { rerun: deployRerunCommand(apply) };
  const pins = parseEnvironment(await readFile(envFile, 'utf8'));
  const copyImages = () =>
    lifecycleStep(
      base,
      'Copy the release images',
      (context) =>
        cloudRunImages(options, {
          cloudRunModule,
          pins,
          ownerEmail: adminEmail,
          context,
          sandboxInternet: gcp.sandboxInternet === true,
          apps: deployed.apps ?? {},
          registry: expectedImageRegistry(gcp, resourceName),
        }),
      rerun,
    );
  // Cloud SQL takes 15 to 18 minutes and needs no image, so a first apply creates it meanwhile.
  const copies =
    apply && !(await holdsDatabase(base, moduleDirectory))
      ? await copyWhileCreatingDatabase(copyImages, () =>
          lifecycleStep(
            base,
            'Create Cloud SQL and its private network while the images copy',
            (context) => applyDatabase(context, moduleDirectory, target.variablesFile),
            rerun,
          ),
        )
      : await copyImages();
  if (copies === null) throw new Error('The release images were not located. Nothing was applied.');
  const toolEnvironment = withCopiedImages(options.env, copies);
  await renderStack(options, toolEnvironment);
  // The apps' copied references are known only now, so the variables are written once more.
  await writeProjectVariables(
    moduleDirectory,
    gcp,
    resourceName,
    env,
    copiedApps(deployed, copies),
  );
  return toolEnvironment;
}

async function applyManagedStack(
  deployment: GcpDeployment,
  target: TerraformTarget,
  prepared: { readonly oidcSecret: string | null; readonly toolEnvironment: NodeJS.ProcessEnv },
): Promise<GcpStackState> {
  const { options, cloudRunModule } = deployment;
  const { apply, stateDirectory } = options;
  const { moduleDirectory } = cloudRunModule;
  const envFile = path.join(stateDirectory, '.env');
  const { oidcSecret, toolEnvironment } = prepared;
  const rerun = { rerun: deployRerunCommand(apply) };
  const redact = createRedactor(
    {
      ...parseEnvironment(await readFile(envFile, 'utf8')),
      ...(oidcSecret === null ? {} : { AW_OIDC_CLIENT_SECRET: oidcSecret }),
    },
    await readFile(path.join(stateDirectory, 'agent-workspace.yaml'), 'utf8'),
  );
  const context: DeployContext = {
    runner: options.runner ?? spawnTool,
    directory: stateDirectory,
    env: toolEnvironment,
    cloud: 'gcp',
    out: (text) => void process.stdout.write(redact(text)),
    err: (text) => void process.stderr.write(redact(text)),
  };
  let createsWeb = false;
  const outcome = await lifecycleStep(
    context,
    apply ? 'Plan and apply' : 'Plan',
    (stepContext) =>
      deployWithTerraform(stepContext, target, apply, async (planFile) => {
        createsWeb = planCreatesWeb(await showPlanSummary(stepContext, moduleDirectory, planFile));
      }),
    { ...rerun, redact },
  );
  reportStackOutcome(context, outcome);
  return finishStack(deployment, { outcome, createsWeb, context });
}

function reportStackOutcome(
  context: DeployContext,
  outcome: import('./steps.ts').DeployOutcome,
): void {
  if (!outcome.changes) {
    context.out('No changes: the deployment matches agent-workspace.yaml.\n');
  } else if (outcome.applied) {
    context.out('Applied.\n');
  } else {
    context.out('Changes are pending; nothing was applied. Re-run with --yes to apply them.\n');
  }
}

async function finishStack(
  deployment: GcpDeployment,
  applied: {
    readonly outcome: import('./steps.ts').DeployOutcome;
    readonly createsWeb: boolean;
    readonly context: DeployContext;
  },
): Promise<GcpStackState> {
  const { options, deployed, gcp, profile, cloudRunModule, created } = deployment;
  const { stateDirectory } = options;
  const { moduleDirectory } = cloudRunModule;
  const adminEmail = profile.identity.bootstrapAdmin;
  const envFile = path.join(stateDirectory, '.env');
  const { outcome, createsWeb, context } = applied;
  const webUrl =
    outcome.applied || !outcome.changes
      ? await readTerraformOutput(context, moduleDirectory, 'web_url')
      : null;
  const loadBalancerIp =
    outcome.applied || !outcome.changes
      ? await readTerraformOutput(context, moduleDirectory, 'load_balancer_ip')
      : null;
  const appUrls =
    (outcome.applied || !outcome.changes) && Object.keys(deployed.apps ?? {}).length > 0
      ? await readAppUrls(context, moduleDirectory)
      : {};
  const location = gcp.modelLocation ?? 'global';
  const seeded =
    outcome.applied && createsWeb && webUrl !== null
      ? await seedModel(options, context, {
          moduleDirectory,
          envFile,
          webUrl,
          adminEmail,
          location,
        })
      : false;
  return {
    ...outcome,
    created,
    adminEmail,
    envFile,
    moduleDirectory,
    webUrl,
    loadBalancerIp,
    appUrls,
    seededLocation: seeded ? location : null,
  };
}

/** The first deploy's model step; its Owner password is read here and masked in what it prints. */
async function seedModel(
  options: DeployProjectEnvironmentOptions,
  context: DeployContext,
  seed: {
    readonly moduleDirectory: string;
    readonly envFile: string;
    readonly webUrl: string;
    readonly adminEmail: string;
    readonly location: VertexLocation;
  },
): Promise<boolean> {
  let redact = createRedactor({});
  const masked: DeployContext = {
    ...context,
    out: (text) => context.out(redact(text)),
    err: (text) => context.err(redact(text)),
  };
  return lifecycleStep(
    masked,
    'Connect Claude on Vertex AI',
    (step) =>
      seedVertexConnection(step, {
        webUrl: seed.webUrl,
        adminEmail: seed.adminEmail,
        location: seed.location,
        password: async () => {
          const password = await readOwnerPassword(step, seed.moduleDirectory);
          redact = createRedactor({
            ...parseEnvironment(await readFile(seed.envFile, 'utf8')),
            BOOTSTRAP_ADMIN_PASSWORD: password,
          });
          return password;
        },
        ...fetchOption(options),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      }),
    { rerun: deployRerunCommand(options.apply) },
  );
}
