/**
 * The bridge from a v2 project file to the v1 deployment profile `deploy` already drives
 * (issue #621, ADR-0103's amendment).
 *
 * A v2 environment names only a deploy recipe (`target`) and the URL it is served at; the
 * profile — where its database, objects, secrets and sandboxes live — follows from the recipe,
 * through the same per-cloud defaults `create-agent-workspace --cloud` writes. The profile is
 * internal: a customer edits `agent-workspace.yaml` and never sees it.
 */
import { lookup } from 'node:dns/promises';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse, stringify } from 'yaml';
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import type {
  ProductionEnvironment,
  ProjectDocument,
} from '@indx-workspace/contracts/project-file';

import { createWorkspace } from '../create.ts';
import { parseEnvironment, resolveDeploymentImages, type DeploymentImages } from '../deployment.ts';
import {
  ProfileError,
  renderProfileDocument,
  validateProfile,
  type DeploymentProfile,
} from '../profile.ts';
import { ENV_IMAGE_KEYS } from '../render/env.ts';
import { writeFileAtomically } from '../render/write-file.ts';
import { PLATFORM_IMAGE_VERSION } from '../release-images.ts';
import {
  CLOUD_RUN_IMAGES,
  copyContext,
  copyImagesToArtifactRegistry,
  type CloudRunImage,
} from './cloud-run-images.ts';
import { cloudRunModuleDirectory, materializeCloudRunModule } from './cloud-run-module.ts';
import { runDeployCommand } from './command.ts';
import { deployWithHelm } from './helm.ts';
import { DEPLOY_RECIPES } from './recipes.ts';
import { createRedactor } from './redact.ts';
import { isMissingTool, spawnTool, type ToolResult, type ToolRunner } from './runner.ts';
import type { DeployOutcome } from './steps.ts';
import { assertModuleInitialised } from './targets.ts';

/** The slug the vercel target names its projects after, so `aw deploy` can print their domains. */
export { composeProjectName } from '../render/env.ts';

/** The environments `aw deploy` takes to a deployment; `local` is `aw dev`'s. */
export type DeployableEnvironment = 'production';

/** `environments.<environment>`, refused at its path when the project does not define it. */
function deployedEnvironment(
  project: ProjectDocument,
  environment: DeployableEnvironment,
): ProductionEnvironment {
  const deployed = project.environments[environment];
  if (deployed === undefined) {
    throw new ProfileError(`environments.${environment}`, 'is not defined; add target and url');
  }
  return deployed;
}

/**
 * The v1 profile `environment` of `project` deploys as. Pure: it reads nothing and writes nothing.
 * The bootstrap Owner is the `local` environment's, because `production` carries only `target`
 * and `url`.
 *
 * @throws {ProfileError} when the project has no such environment, or the derived profile fails
 * the CLI's profile schema.
 */
export function projectToDeploymentProfile(
  project: ProjectDocument,
  environment: DeployableEnvironment,
): DeploymentProfile {
  const recipe = DEPLOY_RECIPES[deployedEnvironment(project, environment).target];
  recipe.checkProject(project);
  return validateProfile({
    ...recipe.profile(project.name),
    identity: project.environments.local.identity,
  });
}

/** The Node.js major a deploy must run on: the CLI's own `engines` floor. */
const NODE_MAJOR_REQUIRED = 24;

export interface DeployProjectEnvironmentOptions {
  readonly project: ProjectDocument;
  readonly environment: DeployableEnvironment;
  /** `--yes`: apply the plan. Without it nothing is deployed. */
  readonly apply: boolean;
  /**
   * The internal v1 deployment this environment drives,
   * `~/.config/agent-workspace/deployments/<project>/<env>`. Created on the first run with
   * freshly generated secrets, which are never regenerated after.
   */
  readonly stateDirectory: string;
  /**
   * `--infra`: the `infra/` directory of a claude-agent-workspace checkout, whose gcp-cloudrun
   * Terraform module is applied instead of the one this CLI ships. Optional for that target and
   * for kubernetes (whose chart is `infra/helm/agent-workspace`, shipped too), refused by single-vm.
   */
  readonly infraDirectory?: string;
  /**
   * The project directory, whose `web/` frontend the vercel target deploys as its own project. The
   * first one to deploy is recorded beside the state, and another is refused (BH061-028).
   */
  readonly projectDirectory?: string;
  /** Runs `docker` and `terraform`; the suite injects a stub. */
  readonly runner?: ToolRunner;
  /** The tools' environment, and where `AW_<NAME>_IMAGE` overrides are read. */
  readonly env?: NodeJS.ProcessEnv;
  /** The images a first run pins; resolved from the release otherwise. The suite injects them. */
  readonly images?: DeploymentImages;
  /** Resolves the url host; `dns.lookup` unless the suite injects one. */
  readonly resolveHost?: (hostname: string) => Promise<unknown>;
  /** `process.versions.node` unless the suite says otherwise. */
  readonly nodeVersion?: string;
}

export interface ProjectDeployOutcome extends DeployOutcome {
  /** What the Owner does next, in order; `aw deploy` prints each line. */
  readonly nextSteps: readonly string[];
  /** Whether this run created the state directory and its secrets. */
  readonly created: boolean;
  readonly adminEmail: string;
  /**
   * The state's `.env`; single-vm's holds `BOOTSTRAP_ADMIN_PASSWORD`. Only its path is printed.
   * For kubernetes, which keeps no `.env` (the operator creates its Secrets in the cluster), the
   * chart values overlay.
   */
  readonly envFile: string;
  /** The gcp-cloudrun Terraform module this run drives; `null` for the other targets. */
  readonly moduleDirectory: string | null;
}

/** What each deploy path computes; `deployProjectEnvironment` adds the recipe's `nextSteps`. */
type DeployedState = Omit<ProjectDeployOutcome, 'nextSteps'>;

/**
 * Run `tool <args>` through the no-shell `ToolRunner`, refusing by name a tool that is not on
 * PATH (`missing`) or does not answer (`failing`).
 */
async function assertToolAnswers(
  options: DeployProjectEnvironmentOptions,
  invocation: { readonly tool: 'docker' | 'helm' | 'terraform'; readonly args: readonly string[] },
  missing: string,
  failing: string,
): Promise<void> {
  let result: ToolResult;
  try {
    result = await (options.runner ?? spawnTool)({
      ...invocation,
      cwd: process.cwd(),
      env: options.env ?? process.env,
    });
  } catch (error) {
    if (!isMissingTool(error)) throw error;
    throw new Error(`${missing} Nothing was created.`, { cause: error });
  }
  if (result.status !== 0) throw new Error(`${failing} Nothing was created.`);
}

/**
 * The Owner prerequisites a single-VM deploy needs beyond Node.js, each refused by name before
 * anything is created. The DNS record is demanded only by `--yes`: a plan deploys nothing, so it
 * can run before the record exists.
 */
async function assertSingleVmPrerequisites(
  options: DeployProjectEnvironmentOptions,
  url: string,
): Promise<void> {
  await assertToolAnswers(
    options,
    { tool: 'docker', args: ['compose', 'version'] },
    'Docker Engine is not installed or not on PATH; the single-vm target runs it. Install ' +
      'Docker Engine and its Compose plugin.',
    '`docker compose version` failed: the Docker Compose plugin is missing or the Docker ' +
      'daemon is not reachable. Install docker-compose-plugin.',
  );
  if (!options.apply) return;
  const { hostname } = new URL(url);
  try {
    await (options.resolveHost ?? lookup)(hostname);
  } catch (error) {
    throw new Error(
      `The url host ${hostname} does not resolve. Add a DNS A record for it pointing at this ` +
        'VM, then re-run with --yes. Nothing was applied.',
      { cause: error },
    );
  }
}

/** The Terraform module the gcp-cloudrun recipe applies, beneath `--infra`. */
const CLOUD_RUN_MODULE = path.join('terraform', 'gcp-cloudrun');
const PROJECT_ID_LINE = /^\s*project_id\s*=/mu;

interface CloudRunModule {
  /** The `infra/` directory `agent-workspace deploy --infra` takes. */
  readonly infra: string;
  readonly moduleDirectory: string;
}

/**
 * The Owner prerequisites a Cloud Run deploy needs beyond Node.js, each refused by name before a
 * deployment is created: the module (the one this CLI ships unless `--infra` names a checkout's),
 * its `project_id`, Terraform, and an initialised module. Without `--infra` the shipped module is
 * first written beside the state directory, which is where the Owner's `terraform.tfvars` and
 * `terraform init` belong.
 */
async function assertCloudRunPrerequisites(
  options: DeployProjectEnvironmentOptions,
): Promise<CloudRunModule> {
  const shipped = options.infraDirectory === undefined;
  const infra = options.infraDirectory ?? (await materializeCloudRunModule(options.stateDirectory));
  const moduleDirectory = shipped
    ? cloudRunModuleDirectory(options.stateDirectory)
    : path.join(infra, CLOUD_RUN_MODULE);
  if (!(await isPresent(path.join(moduleDirectory, 'main.tf')))) {
    throw new Error(
      `${moduleDirectory} holds no Terraform module. --infra must name the infra/ directory of a ` +
        'claude-agent-workspace checkout. Nothing was created.',
    );
  }
  const tfvars = path.join(moduleDirectory, 'terraform.tfvars');
  const declared =
    (await isPresent(tfvars)) && PROJECT_ID_LINE.test(await readFile(tfvars, 'utf8'));
  if (!declared && !options.env?.['TF_VAR_project_id']) {
    throw new Error(
      'The gcp-cloudrun module has no project_id: add project_id = "<your GCP project id>" to ' +
        `${tfvars}, or set TF_VAR_project_id. Nothing was deployed.`,
    );
  }
  await assertToolAnswers(
    options,
    { tool: 'terraform', args: ['version'] },
    'Terraform is not installed or not on PATH; the gcp-cloudrun target runs it. Install ' +
      'Terraform 1.8 or later.',
    '`terraform version` failed. Reinstall Terraform 1.8 or later.',
  );
  await assertModuleInitialised('gcp-cloudrun', moduleDirectory);
  return { infra, moduleDirectory };
}

/**
 * Cloud Run pulls only from Artifact Registry, so each image's reference — what `render` will pin:
 * an `AW_<NAME>_IMAGE` override, else `pinned` (the existing state's pin, or the images a first run
 * was given), else the release default on ghcr.io — is copied there by digest when it is not
 * already. `null` when copies were pending: a plan copied nothing, and `--yes` copied them but
 * stops before Terraform so the first apply is one `--plan` showed (ADR-0094); no state may pin
 * them yet. Otherwise the copies are returned as the overrides that make `render` pin them.
 */
async function cloudRunImages(
  options: DeployProjectEnvironmentOptions,
  cloudRunModule: CloudRunModule,
  pins: Readonly<Record<string, string>> | null,
  ownerEmail: string,
): Promise<DeploymentImages | null> {
  const pinned: Partial<Record<CloudRunImage, string>> = {};
  for (const name of CLOUD_RUN_IMAGES) {
    const reference = pins === null ? options.images?.[name] : pins[ENV_IMAGE_KEYS[name]];
    if (reference !== undefined) pinned[name] = reference;
  }
  const resolved = resolveDeploymentImages('gcp', options.env, pinned);
  const env = options.env ?? process.env;
  return copyImagesToArtifactRegistry({
    context: copyContext(options.runner ?? spawnTool, env, process.cwd()),
    moduleDirectory: cloudRunModule.moduleDirectory,
    references: {
      web: resolved.web,
      gateway: resolved.gateway,
      runner: resolved.runner,
      runtime: resolved.runtime,
    },
    apply: options.apply,
    tag: PLATFORM_IMAGE_VERSION,
    ownerEmail,
  });
}

/**
 * `.env` with `BOOTSTRAP_ADMIN` set to the project's Owner. `render` owns only the image lines, so
 * an Owner email changed after the first deploy is carried here; no other line — the master key
 * and the generated password included — is touched.
 */
function withBootstrapAdmin(env: string, email: string): string {
  return env.replace(/^BOOTSTRAP_ADMIN=.*$/mu, () => `BOOTSTRAP_ADMIN=${email}`);
}

function byCodeUnit(left: string, right: string): number {
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

/**
 * JSON with object keys sorted at every depth and no whitespace, so equal policies are equal
 * strings. Restated from `aw dev`'s writer: the published CLI must not import `embedded`.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries: [string, unknown][] = Object.entries(value);
    return `{${entries
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => byCodeUnit(left, right))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const POLICY_LINE = /^AW_DEPLOYMENT_POLICY=/u;

/**
 * `.env` with `AW_DEPLOYMENT_POLICY` set to the project's policy ceiling, or without the line when
 * the project has none: the project file owns the deployment's ceiling, as it owns its Owner. The
 * JSON is single-quoted, which Compose reads literally (no `$` interpolation, no `#` comment), and
 * its own `'` is written as the JSON escape `\u0027`, the same string.
 */
function withDeploymentPolicy(env: string, policy: ProjectPolicy | undefined): string {
  const rest = env
    .split('\n')
    .filter((line) => !POLICY_LINE.test(line))
    .join('\n');
  if (policy === undefined) return rest;
  const json = canonicalJson(policy).replaceAll("'", '\\u0027');
  return `${rest.trimEnd()}\nAW_DEPLOYMENT_POLICY='${json}'\n`;
}

const PUBLIC_URL_LINE = /^AW_PUBLIC_URL=/u;
const PUBLIC_URL_COMMENT =
  '# Public https origin of this deployment (no path). A2A agent cards (ADR-0135) and the OAuth issuer (ADR-0134) use it; empty keeps them off.';

/**
 * `.env` with `AW_PUBLIC_URL` set to the project's production origin: the project file owns the
 * deployment's public URL, and an upsert (unlike `render`, which never runs again for an existing
 * state directory) reaches deployments made before this line existed. Appended last, with its
 * comment, so a repeat run rewrites the same bytes.
 */
function withPublicUrl(env: string, url: string): string {
  const rest = env
    .split('\n')
    .filter((line) => line !== PUBLIC_URL_COMMENT && !PUBLIC_URL_LINE.test(line))
    .join('\n');
  return `${rest.trimEnd()}\n${PUBLIC_URL_COMMENT}\nAW_PUBLIC_URL=${new URL(url).origin}\n`;
}

async function isPresent(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** `infra/helm/agent-workspace`, beneath `--infra`. */
const CHART_DIRECTORY = path.join('helm', 'agent-workspace');

/**
 * The chart this CLI version ships, held byte-identical to `infra/helm/agent-workspace` by
 * `helm-chart.test.ts`, so the kubernetes target needs no checkout (BH061-031). Helm reads a chart
 * directory in place and writes nothing beside it, so unlike the Terraform module it is not copied
 * out of the package. Resolves from `src/deploy` and `dist/deploy` alike.
 */
const SHIPPED_CHART = fileURLToPath(
  new URL('../../modules/helm/agent-workspace/', import.meta.url),
);

type Overlay = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Overlay {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The overlay a previous run wrote, or `{}`: the images it pinned and the ingress it chose. */
async function readHelmOverlay(file: string): Promise<Overlay> {
  if (!(await isPresent(file))) return {};
  const overlay: unknown = parse(await readFile(file, 'utf8'));
  return isRecord(overlay) ? overlay : {};
}

function pinnedImages(overlay: Overlay): Partial<DeploymentImages> {
  const images = isRecord(overlay['images']) ? overlay['images'] : {};
  const runtime = isRecord(images['runtime']) ? images['runtime'] : {};
  const web = text(images['web']);
  const gateway = text(images['gateway']);
  const runner = text(images['runnerManager']);
  const engine = text(runtime['claude-agent-sdk']);
  return {
    ...(web === undefined ? {} : { web }),
    ...(gateway === undefined ? {} : { gateway }),
    ...(runner === undefined ? {} : { runner }),
    ...(engine === undefined ? {} : { runtime: engine }),
  };
}

/** The shape `values.schema.json` accepts for `database.cidr`. */
const CIDR = /^[0-9a-fA-F:.]+\/[0-9]{1,3}$/u;

/**
 * `database.cidr` from `AW_DATABASE_CIDR`, or the previous overlay's when a later run does not set
 * it; `undefined` leaves the database egress rule open to any address.
 *
 * @throws {Error} when `AW_DATABASE_CIDR` is not a CIDR.
 */
function databaseCidr(previous: Overlay, env: NodeJS.ProcessEnv): string | undefined {
  const chosen = text(env['AW_DATABASE_CIDR']);
  if (chosen !== undefined && !CIDR.test(chosen)) {
    throw new Error('AW_DATABASE_CIDR must be a CIDR such as 10.20.0.0/24. Nothing was written.');
  }
  const before = isRecord(previous['database']) ? previous['database'] : {};
  return chosen ?? text(before['cidr']);
}

/**
 * The chart values `aw deploy` owns for a Kubernetes environment: the four pinned images, the
 * Ingress for the environment's `url`, the database CIDR, the project's policy ceiling and the
 * `url`'s origin as `publicUrl` (`AW_PUBLIC_URL`, ADR-0135). The
 * Ingress class, cert-manager issuer and database CIDR come from `AW_INGRESS_CLASS_NAME`,
 * `AW_TLS_CLUSTER_ISSUER` and `AW_DATABASE_CIDR`, and are kept from the previous overlay when a
 * later run does not set them. No credential is written: the three Secrets the chart reads are the
 * operator's (docs/deploy/kubernetes.md).
 */
function helmOverlay(
  project: ProjectDocument,
  url: string,
  images: DeploymentImages,
  previous: Overlay,
  env: NodeJS.ProcessEnv,
  cidr: string | undefined,
): string {
  const { hostname, origin } = new URL(url);
  const before = isRecord(previous['ingress']) ? previous['ingress'] : {};
  const beforeTls = isRecord(before['tls']) ? before['tls'] : {};
  const className = text(env['AW_INGRESS_CLASS_NAME']) ?? text(before['className']);
  const clusterIssuer = text(env['AW_TLS_CLUSTER_ISSUER']) ?? text(beforeTls['clusterIssuer']);
  return stringify({
    images: {
      web: images.web,
      gateway: images.gateway,
      runnerManager: images.runner,
      runtime: { 'claude-agent-sdk': images.runtime },
    },
    ingress: {
      enabled: true,
      host: hostname,
      ...(className === undefined ? {} : { className }),
      ...(clusterIssuer === undefined ? {} : { tls: { clusterIssuer } }),
    },
    ...(cidr === undefined ? {} : { database: { cidr } }),
    ...(project.policy === undefined ? {} : { deploymentPolicy: canonicalJson(project.policy) }),
    publicUrl: origin,
  });
}

/**
 * `aw deploy` for the kubernetes target: write the overlay beneath the state directory and
 * install the chart with Helm (ADR-0123). The operator-created Secrets are neither read nor
 * written here.
 */
async function deployToKubernetes(
  options: DeployProjectEnvironmentOptions,
  deployed: ProductionEnvironment,
): Promise<DeployedState> {
  const { project, apply, stateDirectory, infraDirectory } = options;
  const chart =
    infraDirectory === undefined ? SHIPPED_CHART : path.join(infraDirectory, CHART_DIRECTORY);
  if (!(await isPresent(path.join(chart, 'Chart.yaml')))) {
    throw new Error(
      `${chart} holds no Helm chart. --infra must name the infra/ directory of a ` +
        'claude-agent-workspace checkout. Nothing was created.',
    );
  }
  await assertToolAnswers(
    options,
    { tool: 'helm', args: ['version'] },
    'Helm is not installed or not on PATH; the kubernetes target runs it. Install Helm 3 or later.',
    '`helm version` failed. Reinstall Helm 3 or later.',
  );

  const env = options.env ?? process.env;
  const operatorValues = text(env['AW_HELM_VALUES']);
  const operatorValuesFile =
    operatorValues === undefined ? undefined : path.resolve(operatorValues);
  if (operatorValuesFile !== undefined && !(await isFile(operatorValuesFile))) {
    throw new Error(
      `AW_HELM_VALUES names ${operatorValuesFile}, which is not a file. Nothing was written.`,
    );
  }
  const overlayFile = path.join(stateDirectory, 'deploy', 'helm', 'values.yaml');
  const created = !(await isPresent(overlayFile));
  const previous = await readHelmOverlay(overlayFile);
  // Any cloud but `local` resolves the four platform images alone: a cluster has no Compose store.
  const images = resolveDeploymentImages('gcp', env, {
    ...options.images,
    ...pinnedImages(previous),
  });
  const cidr = databaseCidr(previous, env);
  const contents = helmOverlay(project, deployed.url, images, previous, env, cidr);
  if (cidr === undefined) {
    process.stderr.write(
      'Warning: AW_DATABASE_CIDR is not set, so database egress is open to any address on ' +
        'database.port. Set it to the PostgreSQL address range to narrow it.\n',
    );
  }
  await mkdir(path.dirname(overlayFile), { recursive: true, mode: 0o700 });
  await writeFileAtomically(overlayFile, contents, null);

  const redact = createRedactor({});
  const outcome = await deployWithHelm(
    {
      runner: options.runner ?? spawnTool,
      directory: stateDirectory,
      env,
      cloud: 'kubernetes',
      out: (message) => void process.stdout.write(redact(message)),
      err: (message) => void process.stderr.write(redact(message)),
    },
    {
      kind: 'helm',
      chart,
      flavourFile: path.join(chart, 'values.yaml'),
      ...(operatorValuesFile === undefined ? {} : { operatorValuesFile }),
      overlayFile,
    },
    apply,
  );
  return {
    ...outcome,
    created,
    adminEmail: project.environments.local.identity.bootstrapAdmin,
    envFile: overlayFile,
    moduleDirectory: null,
  };
}

/** Beside a project's environment states: the directory of the project that owns them. */
function stateOwnerFile(stateDirectory: string): string {
  return path.join(path.dirname(stateDirectory), 'project-directory');
}

/**
 * The state is keyed by the project's name, so two projects of one name would share it, and the
 * second would be told its deployment is up to date (BH061-028). The first project to deploy
 * records its directory; any other directory is refused rather than handed that state.
 */
async function claimState(stateDirectory: string, projectDirectory: string): Promise<void> {
  const owner = stateOwnerFile(stateDirectory);
  const mine = path.resolve(projectDirectory);
  if (!(await isPresent(owner))) {
    await mkdir(path.dirname(owner), { recursive: true, mode: 0o700 });
    await writeFileAtomically(owner, `${mine}\n`, null);
    return;
  }
  const recorded = (await readFile(owner, 'utf8')).trim();
  if (recorded !== mine) {
    throw new Error(
      `The deployment state in ${path.dirname(stateDirectory)} belongs to the project at ` +
        `${recorded}, which has the same name. Give this project another name in its ` +
        `agent-workspace.yaml, or, if that project has moved here, delete ${owner}. ` +
        'Nothing was created.',
    );
  }
}

function assertNodeVersion(options: DeployProjectEnvironmentOptions): void {
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  if (Number.parseInt(nodeVersion, 10) < NODE_MAJOR_REQUIRED) {
    throw new Error(
      `Node.js ${String(NODE_MAJOR_REQUIRED)} or later is required; this is ${nodeVersion}. ` +
        `Install Node.js ${String(NODE_MAJOR_REQUIRED)}. Nothing was created.`,
    );
  }
}

/**
 * `aw deploy <env>`: bridge the environment to its v1 profile, keep the internal deployment at
 * `stateDirectory` in step with it, and run `agent-workspace deploy` over it in-process. Plans
 * unless `apply`.
 *
 * @throws {ProfileError} when the environment is missing or its profile is refused.
 * @throws {Error} naming the missing Owner prerequisite, or the deploy step that failed.
 */
export async function deployProjectEnvironment(
  options: DeployProjectEnvironmentOptions,
): Promise<ProjectDeployOutcome> {
  const { project, environment, apply, stateDirectory } = options;
  const deployed = deployedEnvironment(project, environment);
  const recipe = DEPLOY_RECIPES[deployed.target];
  if (options.projectDirectory !== undefined) {
    await claimState(stateDirectory, options.projectDirectory);
  }
  const finish = (state: DeployedState, frontend: boolean): ProjectDeployOutcome => ({
    ...state,
    nextSteps: recipe.nextSteps({
      projectName: project.name,
      url: deployed.url,
      adminEmail: state.adminEmail,
      envFile: state.envFile,
      moduleDirectory: state.moduleDirectory,
      frontend,
    }),
  });
  if (deployed.target === 'kubernetes') {
    assertNodeVersion(options);
    return finish(await deployToKubernetes(options, deployed), false);
  }
  const profile = projectToDeploymentProfile(project, environment);
  assertNodeVersion(options);
  const envFile = path.join(stateDirectory, '.env');
  const created = !(await isPresent(stateDirectory));
  const adminEmail = profile.identity.bootstrapAdmin;
  let infra: string | null = null;
  let moduleDirectory: string | null = null;
  let cloudRunReady: DeploymentImages | null = null;
  let hasFrontend = false;
  let toolEnvironment = options.env;
  if (recipe.infraRefusal !== null && options.infraDirectory !== undefined) {
    throw new Error(recipe.infraRefusal);
  }
  if (deployed.target === 'single-vm') {
    await assertSingleVmPrerequisites(options, deployed.url);
  } else if (deployed.target === 'vercel') {
    // The control plane's own URL is the project file's `url`; the Vercel target reads it from here.
    const frontend =
      options.projectDirectory === undefined ? null : path.join(options.projectDirectory, 'web');
    hasFrontend = frontend !== null && (await isPresent(path.join(frontend, 'package.json')));
    toolEnvironment = {
      ...(options.env ?? process.env),
      CONTROL_PLANE_URL: deployed.url,
      AGENT_WORKSPACE_PROJECT_NAME: project.name,
      ...(frontend !== null && hasFrontend ? { AGENT_WORKSPACE_FRONTEND: frontend } : {}),
    };
  } else {
    const cloudRunModule = await assertCloudRunPrerequisites(options);
    infra = cloudRunModule.infra;
    moduleDirectory = cloudRunModule.moduleDirectory;
    const pins = created ? null : parseEnvironment(await readFile(envFile, 'utf8'));
    cloudRunReady = await cloudRunImages(options, cloudRunModule, pins, adminEmail);
    if (cloudRunReady === null) {
      return finish(
        { changes: true, applied: false, created: false, adminEmail, envFile, moduleDirectory },
        false,
      );
    }
    const copies = cloudRunReady;
    toolEnvironment = {
      ...(options.env ?? process.env),
      ...Object.fromEntries(
        CLOUD_RUN_IMAGES.map((name) => [`AW_${name.toUpperCase()}_IMAGE`, copies[name]]),
      ),
    };
  }

  if (created) {
    // Resolved first, so an unpublished release is refused before anything is created.
    const images =
      cloudRunReady ?? options.images ?? resolveDeploymentImages(profile.cloud, options.env);
    await mkdir(path.dirname(stateDirectory), { recursive: true, mode: 0o700 });
    await createWorkspace(stateDirectory, null, {
      deployState: { profile, projectName: project.name },
      images,
    });
  } else {
    await writeFileAtomically(
      path.join(stateDirectory, 'agent-workspace.yaml'),
      renderProfileDocument(profile),
      null,
    );
  }
  // The TLS proxy settings are applied until their marker is present, so a first run interrupted
  // after `createWorkspace` is still hardened, and an Owner's later edit is kept. `.env` is
  // replaced through a file opened `0600`, so the secrets are never readable by anyone else.
  const current = await readFile(envFile, 'utf8');
  let next = recipe.hardenEnv(withBootstrapAdmin(current, profile.identity.bootstrapAdmin));
  // Compose forwards the line to single-vm's web; `render` gives it to Cloud Run's web as the
  // gcp-cloudrun module's `deployment_policy`.
  next = withDeploymentPolicy(next, project.policy);
  next = withPublicUrl(next, deployed.url);
  if (next !== current) await writeFileAtomically(envFile, next, 0o600);

  const outcome = await runDeployCommand(
    [stateDirectory, ...(apply ? ['--yes'] : []), ...(infra === null ? [] : ['--infra', infra])],
    {
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      ...(toolEnvironment === undefined ? {} : { environment: toolEnvironment }),
    },
  );
  return finish({ ...outcome, created, adminEmail, envFile, moduleDirectory }, hasFrontend);
}
