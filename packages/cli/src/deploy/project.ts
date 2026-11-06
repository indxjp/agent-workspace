/**
 * The bridge from a v2 project file to the v1 deployment profile `deploy` already drives
 * (issue #621, ADR-0103's amendment).
 *
 * A v2 environment names only a deploy recipe (`target`) and the URL it is served at; the
 * profile — where its database, objects, secrets and sandboxes live — follows from the recipe,
 * through the same per-cloud defaults `create-agent-workspace --cloud` writes. The profile is
 * internal: a customer edits `agent-workspace.yaml` and never sees it.
 */
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse, stringify } from 'yaml';
import type { FeatureId } from '@indx-workspace/contracts/features';
import type { VertexLocation } from '@indx-workspace/contracts/models';
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import type {
  ProductionApp,
  ProductionEnvironment,
  ProductionGcp,
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
import { runRenderCommand } from '../render.ts';
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
import {
  appSecretNames,
  COMPOSE_APPS_FILE,
  COMPOSE_FILE_WITH_APPS,
  composeApps,
  renderComposeApps,
  renderEmptyComposeApps,
} from './compose-apps.ts';
import {
  applyDatabase,
  applyFoundation,
  backendFor,
  copyWhileCreatingDatabase,
  destroyStack,
  ensureStateBucket,
  expectedImageRegistry,
  holdsDatabase,
  moduleResourceName,
  initialiseBackend,
  assertNoConflictingVariables,
  backendRecord,
  legacyVariablesNotice,
  deployRerunCommand,
  lifecycleStep,
  oidcClientSecretId,
  planCreatesWeb,
  readOwnerPassword,
  readTerraformOutput,
  runPreflight,
  seedVertexConnection,
  showPlanSummary,
  stateBucketName,
  storeOidcClientSecret,
  writeProjectVariables,
} from './gcp-lifecycle.ts';
import { deployWithHelm } from './helm.ts';
import { DEPLOY_RECIPES } from './recipes.ts';
import { createRedactor } from './redact.ts';
import { isMissingTool, spawnTool, type ToolResult, type ToolRunner } from './runner.ts';
import type { DeployContext, DeployOutcome } from './steps.ts';
import { assertModuleInitialised, selectTarget } from './targets.ts';
import { gatherStatus, type DeployStatusReport } from './gcp-status.ts';
import { deployWithTerraform } from './terraform.ts';

/** The slug the vercel target names its projects after, so `aw deploy` can print their domains. */
export { composeProjectName } from '../render/env.ts';

/** single-vm's app overlay as `aw deploy` writes it (issue #1512), so a test can boot exactly that file. */
export { COMPOSE_APPS_FILE, COMPOSE_FILE_WITH_APPS, renderComposeApps } from './compose-apps.ts';

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
  /** Makes the Google Cloud preflight's HTTP request (the global `fetch` when unset); the suite injects a stub. */
  readonly fetch?: typeof fetch;
  /**
   * Asks for a value without echoing it; given only when the terminal is interactive. The
   * sign-in client secret (`gcp.oidc`) is asked for this way, once; otherwise it is read from
   * `AW_OIDC_CLIENT_SECRET`.
   */
  readonly readSecret?: (question: string) => Promise<string>;
  /** Waits between the first deploy's model-connection tries; the suite injects a stub. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
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
 * its `project_id` (which `environments.production.gcp` supplies), Terraform, and an initialised
 * module (which the lifecycle creates for a gcp block without `--infra`). Without `--infra` the shipped module is
 * first written beside the state directory, which is where the Owner's `terraform.tfvars` and
 * `terraform init` belong.
 */
async function assertCloudRunPrerequisites(
  options: DeployProjectEnvironmentOptions,
  gcp: ProductionGcp | undefined,
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
  if (gcp === undefined && !declared && !options.env?.['TF_VAR_project_id']) {
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
  // With a gcp block and no --infra, the lifecycle initialises the module itself.
  if (gcp === undefined || !shipped) await assertModuleInitialised('gcp-cloudrun', moduleDirectory);
  return { infra, moduleDirectory };
}

/**
 * Cloud Run pulls only from Artifact Registry, so each image's reference — what `render` will pin:
 * an `AW_<NAME>_IMAGE` override, else `pinned` (the existing state's pin, or the images a first run
 * was given), else the release default on ghcr.io — is copied there by digest when it is not
 * already. `null` when copies were pending and a plan copied nothing: no state may pin them yet,
 * unless `registry` is the computed destination, which a plan can show. Otherwise the copies are
 * returned as the overrides that make `render` pin them.
 */
async function cloudRunImages(
  options: DeployProjectEnvironmentOptions,
  cloudRunModule: CloudRunModule,
  pins: Readonly<Record<string, string>> | null,
  ownerEmail: string,
  context: DeployContext,
  registry?: string,
): Promise<DeploymentImages | null> {
  const pinned: Partial<Record<CloudRunImage, string>> = {};
  for (const name of CLOUD_RUN_IMAGES) {
    const reference = pins === null ? options.images?.[name] : pins[ENV_IMAGE_KEYS[name]];
    if (reference !== undefined) pinned[name] = reference;
  }
  const resolved = resolveDeploymentImages('gcp', options.env, pinned);
  return copyImagesToArtifactRegistry({
    context,
    ...(registry === undefined
      ? {}
      : { registry, sources: () => options.images ?? resolveDeploymentImages('gcp', options.env) }),
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

/** Every IPv4 address of `hostname`: the load balancer's address is IPv4, and a host can have several. */
export function resolveIpv4(
  hostname: string,
  lookupAddresses: typeof lookup = lookup,
): Promise<unknown> {
  return lookupAddresses(hostname, { all: true, family: 4 });
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

const FEATURES_LINE = /^AW_DEPLOYMENT_FEATURES=/u;

/**
 * `.env` with `AW_DEPLOYMENT_FEATURES` set to the project's features as a comma-separated list, or
 * without the line when the project has none (ADR-0160 D5): the project file owns which features
 * the deployment installs, as it owns its ceiling. Feature ids are `[a-z]`, so no quoting is needed.
 */
function withDeploymentFeatures(env: string, features: readonly FeatureId[] | undefined): string {
  const rest = env
    .split('\n')
    .filter((line) => !FEATURES_LINE.test(line))
    .join('\n');
  if (features === undefined) return rest;
  return `${rest.trimEnd()}\nAW_DEPLOYMENT_FEATURES=${features.join(',')}\n`;
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

const COMPOSE_FILE_LINE = /^COMPOSE_FILE=/u;

/** The name of a `NAME=value` line of `.env`, or `undefined` for a comment or a blank line. */
function lineName(line: string): string | undefined {
  return /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(line)?.[1];
}

/**
 * `.env` with each app's database password and identity secret (issue #1512), generated once (32
 * random bytes, base64url, so a URL carries them unescaped) and kept on every later run, then
 * `COMPOSE_FILE` naming the platform's file and the app overlay. The lines are moved to the end in
 * a fixed order, as `withPublicUrl`'s are, so a repeat run rewrites the same bytes.
 */
function withAppSecrets(env: string, apps: Readonly<Record<string, ProductionApp>>): string {
  const names = composeApps(apps).flatMap(({ envName }) => appSecretNames(envName));
  const owned = new Set([...names, 'COMPOSE_FILE']);
  const lines = env.split('\n');
  const values = new Map<string, string>();
  for (const line of lines) {
    const name = lineName(line);
    if (name !== undefined && owned.has(name)) values.set(name, line.slice(name.length + 1));
  }
  const rest = lines.filter((line) => !owned.has(lineName(line) ?? '')).join('\n');
  const secrets = names.map(
    (name) => `${name}=${values.get(name) ?? randomBytes(32).toString('base64url')}`,
  );
  return [rest.trimEnd(), ...secrets, `COMPOSE_FILE=${COMPOSE_FILE_WITH_APPS}`, ''].join('\n');
}

/** `.env` without `COMPOSE_FILE`: Compose reads `compose.yaml` alone again. Secrets are kept. */
function withoutComposeFile(env: string): string {
  return env
    .split('\n')
    .filter((line) => !COMPOSE_FILE_LINE.test(line))
    .join('\n');
}

/** The `app-<name>` services an overlay a previous run wrote starts, for the left-running line. */
async function overlayAppServices(file: string): Promise<readonly string[]> {
  const overlay: unknown = parse(await readFile(file, 'utf8'));
  const services = isRecord(overlay) && isRecord(overlay['services']) ? overlay['services'] : {};
  return Object.keys(services).filter((service) => !service.endsWith('-role'));
}

/**
 * single-vm's app overlay (issue #1512): with apps, `<state>/compose.apps.yaml` is written (`0600`,
 * like `.env`) and `.env` gains the apps' secrets and `COMPOSE_FILE`. With none, an overlay a
 * previous run wrote is emptied and `COMPOSE_FILE` dropped; its containers are left running,
 * because `aw deploy` never destroys (ADR-0103), and the secrets are kept for a later re-add.
 * Returns the next `.env`.
 */
async function syncComposeApps(
  stateDirectory: string,
  deployed: ProductionEnvironment,
  env: string,
): Promise<string> {
  const apps = deployed.apps ?? {};
  const overlayFile = path.join(stateDirectory, COMPOSE_APPS_FILE);
  if (Object.keys(apps).length > 0) {
    await writeFileAtomically(overlayFile, renderComposeApps(apps, deployed.url), 0o600);
    return withAppSecrets(env, apps);
  }
  if (!(await isPresent(overlayFile))) return env;
  const running = await overlayAppServices(overlayFile);
  await writeFileAtomically(overlayFile, renderEmptyComposeApps(), 0o600);
  if (running.length > 0) {
    process.stderr.write(
      `app containers ${running.join(', ')} are left running; aw deploy never removes them\n`,
    );
  }
  return withoutComposeFile(env);
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
 * The chart's `apps` list (issue #1512): per app, in name order, its pinned image, the host its
 * Ingress rule serves and the schema its own role owns, `app_<name>`. The chart's Deployment reads
 * the app's credentials from the operator-created Secret `agent-workspace-app-<name>`; none is here.
 */
function helmApps(apps: Readonly<Record<string, ProductionApp>>): readonly HelmApp[] {
  return composeApps(apps).map(({ name, app, role }) => ({
    name,
    image: app.image,
    host: new URL(app.url).hostname,
    schema: role,
  }));
}

interface HelmApp {
  readonly name: string;
  readonly image: string;
  readonly host: string;
  readonly schema: string;
}

/**
 * The chart values `aw deploy` owns for a Kubernetes environment: the four pinned images, the
 * Ingress for the environment's `url`, the database CIDR, the project's policy ceiling and the
 * `url`'s origin as `publicUrl` (`AW_PUBLIC_URL`, ADR-0135) and, with any, the project's `apps`. The
 * Ingress class, cert-manager issuer and database CIDR come from `AW_INGRESS_CLASS_NAME`,
 * `AW_TLS_CLUSTER_ISSUER` and `AW_DATABASE_CIDR`, and are kept from the previous overlay when a
 * later run does not set them. No credential is written: the three Secrets the chart reads are the
 * operator's (docs/deploy/kubernetes.md).
 */
function helmOverlay(
  project: ProjectDocument,
  deployed: ProductionEnvironment,
  images: DeploymentImages,
  previous: Overlay,
  env: NodeJS.ProcessEnv,
  cidr: string | undefined,
): string {
  const { hostname, origin } = new URL(deployed.url);
  const apps = helmApps(deployed.apps ?? {});
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
    ...(project.features === undefined ? {} : { deploymentFeatures: project.features.join(',') }),
    publicUrl: origin,
    ...(apps.length === 0 ? {} : { apps }),
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
  const contents = helmOverlay(project, deployed, images, previous, env, cidr);
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

/** `env` with each copied image as the `AW_<NAME>_IMAGE` override that makes `render` pin it. */
function withCopiedImages(
  env: NodeJS.ProcessEnv | undefined,
  copies: DeploymentImages,
): NodeJS.ProcessEnv {
  return {
    ...(env ?? process.env),
    ...Object.fromEntries(
      CLOUD_RUN_IMAGES.map((name) => [`AW_${name.toUpperCase()}_IMAGE`, copies[name]]),
    ),
  };
}

/**
 * The state directory and its `.env` kept in step with the project: created on the first run with
 * generated secrets and `images`, and otherwise only the profile and the lines the project file
 * owns are rewritten. The TLS proxy settings are applied until their marker is present, so a first
 * run interrupted after `createWorkspace` is still hardened, and an Owner's later edit is kept.
 * `.env` is replaced through a file opened `0600`, so the secrets are never readable by anyone else.
 */
async function syncDeploymentState(
  options: DeployProjectEnvironmentOptions,
  deployed: ProductionEnvironment,
  profile: DeploymentProfile,
  created: boolean,
  images: () => DeploymentImages,
): Promise<string> {
  const { project, stateDirectory } = options;
  const recipe = DEPLOY_RECIPES[deployed.target];
  const envFile = path.join(stateDirectory, '.env');
  if (created) {
    // Resolved first, so an unpublished release is refused before anything is created.
    const initial = images();
    await mkdir(path.dirname(stateDirectory), { recursive: true, mode: 0o700 });
    await createWorkspace(stateDirectory, null, {
      deployState: { profile, projectName: project.name },
      images: initial,
    });
  } else {
    await writeFileAtomically(
      path.join(stateDirectory, 'agent-workspace.yaml'),
      renderProfileDocument(profile),
      null,
    );
  }
  const current = await readFile(envFile, 'utf8');
  let next = recipe.hardenEnv(withBootstrapAdmin(current, profile.identity.bootstrapAdmin));
  // Compose forwards these lines to single-vm's web; `render` gives them to Cloud Run's web as the
  // gcp-cloudrun module's `deployment_policy` and `deployment_features`.
  next = withDeploymentPolicy(next, project.policy);
  next = withDeploymentFeatures(next, project.features);
  if (deployed.target === 'single-vm') {
    next = await syncComposeApps(stateDirectory, deployed, next);
  }
  next = withPublicUrl(next, deployed.url);
  if (next !== current) await writeFileAtomically(envFile, next, 0o600);
  return envFile;
}

function fetchOption(options: DeployProjectEnvironmentOptions): { readonly fetch?: typeof fetch } {
  return options.fetch === undefined ? {} : { fetch: options.fetch };
}

/** What the gcp lifecycle returns beyond a deploy outcome: the web address, once there is one. */
interface GcpStackState extends DeployedState {
  readonly webUrl: string | null;
  /** `terraform output -raw load_balancer_ip`, once a load balancer exists. */
  readonly loadBalancerIp: string | null;
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
async function deployGcpStack(
  options: DeployProjectEnvironmentOptions,
  deployed: ProductionEnvironment,
  gcp: ProductionGcp,
  profile: DeploymentProfile,
  cloudRunModule: CloudRunModule,
  created: boolean,
  base: DeployContext,
): Promise<GcpStackState> {
  const { project, apply, stateDirectory } = options;
  const { infra, moduleDirectory } = cloudRunModule;
  const env = options.env ?? process.env;
  const adminEmail = profile.identity.bootstrapAdmin;
  const envFile = path.join(stateDirectory, '.env');
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
  await lifecycleStep(
    base,
    'Initialise Terraform',
    (context) => initialiseBackend(context, moduleDirectory, backendFor(gcp, project.name)),
    rerun,
  );

  const initial = (): DeploymentImages => options.images ?? resolveDeploymentImages('gcp', env);
  await syncDeploymentState(options, deployed, profile, created, initial);
  const render = (environment: NodeJS.ProcessEnv) =>
    runRenderCommand([stateDirectory], {
      environment,
      out: () => undefined,
      err: (text) => void process.stderr.write(createRedactor({})(text)),
    });
  await render(env);
  const target = selectTarget({
    profile,
    images: initial(),
    requested: null,
    projectDirectory: stateDirectory,
    infraDirectory: infra,
  });
  if (target.kind !== 'terraform') throw new Error('The gcp-cloudrun target is not Terraform.');

  if (apply && (await readTerraformOutput(base, moduleDirectory, 'image_registry')) === null) {
    await lifecycleStep(
      base,
      'Enable the APIs and create the image repository',
      (context) => applyFoundation(context, moduleDirectory, target.variablesFile),
      rerun,
    );
  }
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
  const pins = parseEnvironment(await readFile(envFile, 'utf8'));
  const copyImages = () =>
    lifecycleStep(
      base,
      'Copy the release images',
      (context) =>
        cloudRunImages(
          options,
          cloudRunModule,
          pins,
          adminEmail,
          context,
          expectedImageRegistry(gcp, resourceName),
        ),
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
  await render(toolEnvironment);

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
  if (!outcome.changes) {
    context.out('No changes: the deployment matches agent-workspace.yaml.\n');
  } else if (outcome.applied) {
    context.out('Applied.\n');
  } else {
    context.out('Changes are pending; nothing was applied. Re-run with --yes to apply them.\n');
  }
  const webUrl =
    outcome.applied || !outcome.changes
      ? await readTerraformOutput(context, moduleDirectory, 'web_url')
      : null;
  const loadBalancerIp =
    outcome.applied || !outcome.changes
      ? await readTerraformOutput(context, moduleDirectory, 'load_balancer_ip')
      : null;
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

/** What `prepareCloudRun` hands back: a finished run, or what `agent-workspace deploy` still needs. */
type CloudRunPreparation =
  | { readonly done: GcpStackState }
  | {
      readonly done: null;
      readonly infra: string;
      readonly moduleDirectory: string;
      readonly images: DeploymentImages;
      readonly toolEnvironment: NodeJS.ProcessEnv;
    };

/**
 * The gcp-cloudrun target up to `agent-workspace deploy`: the Google Cloud preflight, the module's
 * prerequisites, then either the whole managed lifecycle (`gcp` without `--infra`: `done`) or the
 * image copy that precedes the shared plan and apply (a hand-written `terraform.tfvars`, or a
 * checkout named by `--infra`, whose module is never written to).
 */
async function prepareCloudRun(
  options: DeployProjectEnvironmentOptions,
  deployed: ProductionEnvironment,
  profile: DeploymentProfile,
  created: boolean,
): Promise<CloudRunPreparation> {
  const { apply, stateDirectory } = options;
  const gcp = deployed.gcp;
  const adminEmail = profile.identity.bootstrapAdmin;
  const envFile = path.join(stateDirectory, '.env');
  const base = copyContext(options.runner ?? spawnTool, options.env ?? process.env, process.cwd());
  if (gcp !== undefined) {
    await lifecycleStep(
      base,
      'Check the Google Cloud project',
      (context) =>
        runPreflight(context, gcp, apply, {
          ...fetchOption(options),
          ...(gcp.domain === undefined
            ? {}
            : {
                resolveHost: options.resolveHost ?? resolveIpv4,
                loadBalancerIp: () =>
                  readTerraformOutput(
                    { ...context, out: () => undefined },
                    cloudRunModuleDirectory(stateDirectory),
                    'load_balancer_ip',
                  ),
              }),
        }),
      { rerun: deployRerunCommand(apply), quoteError: true },
    );
  }
  const cloudRunModule = await assertCloudRunPrerequisites(options, gcp);
  const { infra, moduleDirectory } = cloudRunModule;
  if (gcp !== undefined && options.infraDirectory === undefined) {
    return {
      done: await deployGcpStack(options, deployed, gcp, profile, cloudRunModule, created, base),
    };
  }
  if (gcp === undefined && options.infraDirectory === undefined) base.out(legacyVariablesNotice());
  // A checkout's module is never written to: the gcp block reaches it as Terraform variables, which
  // rank below its own tfvars files, so a file that names another project or region is refused.
  if (gcp !== undefined) await assertNoConflictingVariables(moduleDirectory, gcp);
  const checkoutEnvironment =
    gcp === undefined
      ? options.env
      : {
          ...(options.env ?? process.env),
          TF_VAR_project_id: gcp.project,
          TF_VAR_region: gcp.region,
          TF_VAR_vertex_location: gcp.modelLocation ?? 'global',
        };
  const pins = created ? null : parseEnvironment(await readFile(envFile, 'utf8'));
  const images = await cloudRunImages(options, cloudRunModule, pins, adminEmail, base);
  if (images === null) {
    return {
      done: {
        changes: true,
        applied: false,
        created: false,
        adminEmail,
        envFile,
        moduleDirectory,
        webUrl: null,
        loadBalancerIp: null,
      },
    };
  }
  return {
    done: null,
    infra,
    moduleDirectory,
    images,
    toolEnvironment: withCopiedImages(checkoutEnvironment, images),
  };
}

/** `terraform output -raw web_url` once a gcp-cloudrun run has left a stack to read it from. */
function stackWebUrl(
  options: DeployProjectEnvironmentOptions,
  environment: NodeJS.ProcessEnv | undefined,
  moduleDirectory: string,
  outcome: DeployOutcome,
): Promise<string | null> {
  if (!outcome.applied && outcome.changes) return Promise.resolve(null);
  const quiet = {
    ...copyContext(options.runner ?? spawnTool, environment ?? process.env, process.cwd()),
    out: () => undefined,
  };
  return readTerraformOutput(quiet, moduleDirectory, 'web_url');
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
  // Refused before the state is claimed; the kubernetes target builds no v1 profile to refuse it.
  recipe.checkProject(project);
  if (options.projectDirectory !== undefined) {
    await claimState(stateDirectory, options.projectDirectory);
  }
  const finish = (
    state: DeployedState,
    frontend: boolean,
    webUrl: string | null = null,
    loadBalancerIp: string | null = null,
    seededLocation: VertexLocation | null = null,
  ): ProjectDeployOutcome => ({
    ...state,
    nextSteps: recipe.nextSteps({
      projectName: project.name,
      url: deployed.url,
      adminEmail: state.adminEmail,
      envFile: state.envFile,
      moduleDirectory: state.moduleDirectory,
      managedStack: deployed.gcp !== undefined && options.infraDirectory === undefined,
      webUrl,
      oidcIssuer: deployed.gcp?.oidc?.issuer ?? null,
      domain: deployed.gcp?.domain ?? null,
      loadBalancerIp,
      seededLocation,
      frontend,
      apps: deployed.apps ?? {},
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
    const prepared = await prepareCloudRun(options, deployed, profile, created);
    if (prepared.done !== null) {
      const { webUrl, loadBalancerIp, seededLocation, ...state } = prepared.done;
      return finish(state, false, webUrl, loadBalancerIp, seededLocation ?? null);
    }
    ({ infra, moduleDirectory, toolEnvironment } = prepared);
    cloudRunReady = prepared.images;
  }

  await syncDeploymentState(
    options,
    deployed,
    profile,
    created,
    () => cloudRunReady ?? options.images ?? resolveDeploymentImages(profile.cloud, options.env),
  );

  const outcome = await runDeployCommand(
    [stateDirectory, ...(apply ? ['--yes'] : []), ...(infra === null ? [] : ['--infra', infra])],
    {
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      ...(toolEnvironment === undefined ? {} : { environment: toolEnvironment }),
    },
  );
  const state = { ...outcome, created, adminEmail, envFile, moduleDirectory };
  if (deployed.target !== 'gcp-cloudrun' || moduleDirectory === null) {
    return finish(state, hasFrontend);
  }
  return finish(
    state,
    false,
    await stackWebUrl(options, toolEnvironment, moduleDirectory, outcome),
  );
}

/** The Google Cloud project and region of `environment`, or the refusal that names how to set them. */
function gcpOf(project: ProjectDocument, environment: DeployableEnvironment): ProductionGcp {
  const deployed = deployedEnvironment(project, environment);
  if (deployed.target !== 'gcp-cloudrun' || deployed.gcp === undefined) {
    throw new ProfileError(
      `environments.${environment}.gcp`,
      'is not defined; this command needs target: gcp-cloudrun and gcp: { project, region }',
    );
  }
  return deployed.gcp;
}

export interface ShowOwnerPasswordOptions {
  readonly project: ProjectDocument;
  readonly environment: DeployableEnvironment;
  readonly stateDirectory: string;
  readonly runner?: ToolRunner;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * `aw deploy production --show-owner-password`: the Owner's generated password, read from the
 * Terraform state with `terraform output -raw`. Returned, never logged: the caller prints it.
 *
 * @throws {ProfileError} when the environment has no gcp block.
 * @throws {Error} when the stack has no password yet.
 */
export async function showOwnerPassword(options: ShowOwnerPasswordOptions): Promise<string> {
  gcpOf(options.project, options.environment);
  const context = {
    ...copyContext(options.runner ?? spawnTool, options.env ?? process.env, process.cwd()),
    out: () => undefined,
  };
  return readOwnerPassword(context, cloudRunModuleDirectory(options.stateDirectory));
}

export interface DestroyProjectEnvironmentOptions extends ShowOwnerPasswordOptions {
  /** Makes the preflight's HTTP request (the global `fetch` when unset); the suite injects a stub. */
  readonly fetch?: typeof fetch;
  /** Asks the Owner `question` and answers the line they typed. */
  readonly confirm: (question: string) => Promise<string>;
}

/** The preflight checks a destroy needs: the tools, the sign-in and the project; not billing or APIs. */
const DESTROY_PREFLIGHT = ['gcloud', 'sign-in', 'gcloud-account', 'project', 'terraform'] as const;

/** What the limited prelude of a stack command says when there is no stack to work on. */
interface NothingDeployed {
  readonly rerun: string;
  readonly noVariables: string;
  readonly noBackend: string;
  readonly noBucket: (bucket: string) => string;
}

/** A stack command's ground: the context, the Terraform module and the variables file it was run with. */
interface InitialisedStack {
  readonly gcp: ProductionGcp;
  readonly context: DeployContext;
  readonly moduleDirectory: string;
  readonly variablesFile: string;
}

/**
 * What `aw deploy destroy production` and `aw deploy status production` share: find the variables
 * file `aw deploy` wrote, run the limited preflight, materialise the module, check the stack used
 * the managed state, rewrite the variables, check the state bucket exists and initialise Terraform.
 * Nothing is created.
 *
 * @throws {Error} with the `refusals` text when there is no stack to work on.
 */
async function initialiseExistingStack(
  options: ShowOwnerPasswordOptions & { readonly fetch?: typeof fetch },
  refusals: NothingDeployed,
): Promise<InitialisedStack> {
  const { project, environment, stateDirectory } = options;
  const gcp = gcpOf(project, environment);
  const env = options.env ?? process.env;
  const context = copyContext(options.runner ?? spawnTool, env, process.cwd());
  const { rerun } = refusals;
  const variablesFile = path.join(
    stateDirectory,
    'deploy',
    'terraform',
    'gcp-cloudrun.auto.tfvars.json',
  );
  if (!(await isPresent(variablesFile))) throw new Error(refusals.noVariables);
  await lifecycleStep(
    context,
    'Check the Google Cloud project',
    (step) =>
      runPreflight(step, gcp, false, {
        only: DESTROY_PREFLIGHT,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
    { rerun },
  );
  await materializeCloudRunModule(stateDirectory);
  const moduleDirectory = cloudRunModuleDirectory(stateDirectory);
  if (!(await isPresent(backendRecord(moduleDirectory)))) throw new Error(refusals.noBackend);
  await writeProjectVariables(moduleDirectory, gcp, moduleResourceName(project.name), env);
  const bucket = await lifecycleStep(
    context,
    'Check the Terraform state bucket',
    (step) => ensureStateBucket(step, gcp, false),
    { rerun },
  );
  if (bucket === 'missing') throw new Error(refusals.noBucket(stateBucketName(gcp)));
  await lifecycleStep(
    context,
    'Initialise Terraform',
    (step) => initialiseBackend(step, moduleDirectory, backendFor(gcp, project.name)),
    { rerun },
  );
  return { gcp, context, moduleDirectory, variablesFile };
}

/**
 * `aw deploy destroy production`: plan the destruction of the stack `aw deploy` made, print what
 * it would delete, and apply that plan only after the Owner types the Google Cloud project id. The
 * state bucket and the local state directory are left in place.
 *
 * @throws {ProfileError} when the environment has no gcp block.
 * @throws {Error} when nothing was deployed from this machine, the typed id differs, or Terraform
 * refuses (Cloud SQL data protection included).
 */
export async function destroyProjectEnvironment(
  options: DestroyProjectEnvironmentOptions,
): Promise<void> {
  const { gcp, context, moduleDirectory, variablesFile } = await initialiseExistingStack(options, {
    rerun: 'aw deploy destroy production',
    noVariables:
      'Nothing was deployed from this machine, so there is nothing to destroy. Deploy it first ' +
      'with `aw deploy production`. Nothing was destroyed.',
    noBackend:
      'Nothing was deployed here by `aw deploy production`, so there is nothing to destroy. ' +
      'A stack deployed with --infra lives in that checkout: destroy it there. Nothing was destroyed.',
    noBucket: (bucket) =>
      `The state bucket gs://${bucket} does not exist, so there is nothing to ` +
      'destroy. Nothing was destroyed.',
  });
  await destroyStack(context, moduleDirectory, variablesFile, gcp.project, options.confirm);
}

export type { DeployStatusReport };

export interface DeployStatusOptions extends ShowOwnerPasswordOptions {
  /** Makes the preflight's HTTP request (the global `fetch` when unset); the suite injects a stub. */
  readonly fetch?: typeof fetch;
}

/**
 * `aw deploy status production`: the versions, revision health, data protection and drift of the
 * stack `aw deploy` made. Read-only: it plans without locking the state and never applies.
 *
 * @throws {ProfileError} when the environment has no gcp block.
 * @throws {Error} when nothing was deployed from this machine, or a tool refuses.
 */
export async function deployStatus(options: DeployStatusOptions): Promise<DeployStatusReport> {
  const nothing = (why: string): string =>
    `Nothing was deployed from this machine, ${why}. Deploy it first with \`aw deploy production\`.`;
  const { gcp, context, moduleDirectory, variablesFile } = await initialiseExistingStack(options, {
    rerun: 'aw deploy status production',
    noVariables: nothing('so there is no status to report'),
    noBackend: nothing(
      'or the stack was deployed with --infra from that checkout, so there is no status to report',
    ),
    noBucket: (bucket) =>
      `The state bucket gs://${bucket} does not exist, so there is no status to report. Deploy it first with \`aw deploy production\`.`,
  });
  return gatherStatus(context, {
    moduleDirectory,
    variablesFile,
    gcp,
    name: moduleResourceName(options.project.name),
  });
}
