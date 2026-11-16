import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  ProductionApp,
  ProductionEnvironment,
  ProjectDocument,
} from '@indx-workspace/contracts/project-file';
import { parse, stringify } from 'yaml';

import { resolveDeploymentImages, type DeploymentImages } from '../deployment.ts';
import { writeFileAtomically } from '../render/write-file.ts';
import { composeApps } from './compose-apps.ts';
import { deployWithHelm } from './helm.ts';
import { canonicalJson } from './project-policy.ts';
import { assertToolAnswers, isFile, isPresent } from './project-prerequisites.ts';
import { type DeployedState, type DeployProjectEnvironmentOptions } from './project-types.ts';
import { createRedactor } from './redact.ts';
import { spawnTool } from './runner.ts';

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
  settings: {
    readonly previous: Overlay;
    readonly env: NodeJS.ProcessEnv;
    readonly cidr: string | undefined;
  },
): string {
  const { previous, env, cidr } = settings;
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
export async function deployToKubernetes(
  options: DeployProjectEnvironmentOptions,
  deployed: ProductionEnvironment,
): Promise<DeployedState> {
  const { project, apply, stateDirectory } = options;
  const { chart, env, operatorValuesFile } = await kubernetesPrerequisites(options);
  const overlayFile = path.join(stateDirectory, 'deploy', 'helm', 'values.yaml');
  const created = !(await isPresent(overlayFile));
  const previous = await readHelmOverlay(overlayFile);
  // Any cloud but `local` resolves the four platform images alone: a cluster has no Compose store.
  const images = resolveDeploymentImages('gcp', env, {
    ...options.images,
    ...pinnedImages(previous),
  });
  const cidr = databaseCidr(previous, env);
  const contents = helmOverlay(project, deployed, images, { previous, env, cidr });
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

async function kubernetesPrerequisites(options: DeployProjectEnvironmentOptions): Promise<{
  readonly chart: string;
  readonly env: NodeJS.ProcessEnv;
  readonly operatorValuesFile: string | undefined;
}> {
  const { infraDirectory } = options;
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
  return { chart, env, operatorValuesFile };
}
