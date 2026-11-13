/**
 * The runner manager's settings (refactoring part 03). `startRunnerManager` and the Vercel Function
 * entry parse them once, before the manager listens, and a refused value stops start-up with every
 * refused group named at once: the listen port, the verification timeout and the driver's settings.
 * Inside one driver the first refused variable stops that driver's parse, as before.
 *
 * Each driver keeps its own parser in its `manager-driver-*.ts` module, a pure function over a
 * record called only from here, so tests pass values in and never touch `process.env`.
 * {@link RUNNER_MANAGER_SETTINGS} lists every variable those parsers read, and
 * `tests/settings-table.test.ts` fails when a read has no row or a row has no read.
 */
import { type RuntimeDriverId } from '@agent-workspace/runtime/driver';
import { type DockerCommand } from '@agent-workspace/runtime/driver/docker';
import {
  engineImageEnvName,
  LEGACY_RUNTIME_IMAGE_ENV,
} from '@agent-workspace/runtime/engine-images';
import { ADAPTER_ENGINE_IDS } from './engines.js';
import { type RunnerManagerOptions } from './manager.js';
import type { DriverOptions } from './manager-driver-settings.js';
import { externalDriverOptions } from './manager-driver-external.js';
import { vercelSandboxDriverOptions } from './manager-driver-vercel.js';
import { cloudRunDriverOptions } from './manager-driver-cloud-run.js';
import { acaSessionsDriverOptions } from './manager-driver-aca.js';
import { cloudflareSandboxDriverOptions } from './manager-driver-cloudflare.js';
import { dockerDriverOptions } from './manager-driver-docker.js';
import { kubernetesDriverOptions } from './manager-driver-kubernetes.js';
import { parsePort } from './server.js';

export type SettingsEnvironment = Readonly<Record<string, string | undefined>>;

/** One row of the generated settings table (`docs/operations/settings.md`, refactoring part 03). */
export interface SettingDescription {
  readonly name: string;
  readonly default: string;
  readonly meaning: string;
}

/** The shortest `RUNNER_MANAGER_TOKEN` the manager accepts (`manager-context.ts` checks it too). */
const MIN_TOKEN_LENGTH = 32;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = '8090';
const DEFAULT_WORKSPACES_ROOT = '/var/lib/agent-workspace/runtimes';

const row = (name: string, unset: string, meaning: string): SettingDescription => ({
  name,
  default: unset,
  meaning,
});

const IMAGE_ROWS: readonly SettingDescription[] = [
  ...ADAPTER_ENGINE_IDS.map((engine) =>
    row(
      engineImageEnvName(engine),
      'unset: the engine is not offered',
      `The sandbox image for the \`${engine}\` engine. Image-based drivers need at least one image, and in production a digest pin (an E2B template is \`<name>:<build_id>\`).`,
    ),
  ),
  row(
    LEGACY_RUNTIME_IMAGE_ENV,
    'unset',
    'The legacy image name for the `claude-agent-sdk` engine, read when its own variable is unset.',
  ),
];

/** The variables {@link readRunnerManagerSettings} reads, for every driver. */
export const RUNNER_MANAGER_SETTINGS: readonly SettingDescription[] = [
  row(
    'RUNTIME_DRIVER',
    'unset: `docker`',
    'Where sandboxes run: `docker`, `cloud-run-service`, `aca-sessions`, `external`, `vercel-sandbox`, `cloudflare-sandbox` or `kubernetes`. Any other value stops start-up.',
  ),
  row(
    'RUNNER_MANAGER_TOKEN',
    'none: start-up stops',
    `The bearer web and the gateway send, at least ${String(MIN_TOKEN_LENGTH)} characters. With \`aca-sessions\` it also keys session names; with \`RUNNER_MANAGER_STATELESS\` it is the seal secret.`,
  ),
  row(
    'RUNTIME_WORKSPACES_ROOT',
    `\`${DEFAULT_WORKSPACES_ROOT}\``,
    'The folder the manager keeps run workspaces in.',
  ),
  row(
    'RUNTIME_VERIFICATION_TIMEOUT_MS',
    '`30000`',
    'How long a new sandbox has to answer its readiness check, in milliseconds: a whole number from 1. Any other value stops start-up.',
  ),
  row('HOST', `\`${DEFAULT_HOST}\``, 'The address the manager listens on.'),
  row(
    'PORT',
    `\`${DEFAULT_PORT}\``,
    'The port the manager listens on, 1 to 65535; `0` asks the system for a free port. Any other value stops start-up.',
  ),
  row(
    'NODE_ENV',
    'unset',
    '`production` makes image-based drivers require digest-pinned images (build-id-pinned templates on `external`).',
  ),
  ...IMAGE_ROWS,
  row(
    'RUNNER_MANAGER_STATELESS',
    'unset: the manager keeps an allocation table',
    '`true` keeps no allocation table (ADR-0126), for a Vercel Function. Only `external` and `vercel-sandbox` serve it; any other value or driver stops start-up.',
  ),
  row(
    'AGENT_WORKSPACE_TOOL_HOST_IMAGE',
    'unset: runs that need a tool sandbox are refused',
    'The tool-host image (an E2B template on `external`) for `docker`, `cloud-run-service` and `external`.',
  ),
  row(
    'AGENT_WORKSPACE_TOOL_SANDBOX_TIMEOUT_SECONDS',
    '`900`',
    'When an unclosed tool sandbox ends, after the last run that opened it (`cloud-run-service`, `external`): 60 to 3600. Any other value stops start-up.',
  ),
  row(
    'AGENT_WORKSPACE_EGRESS_PROXY_IMAGE',
    'unset: no egress proxy beside a sandbox',
    'The egress proxy image started beside each sandbox (`docker`, `kubernetes`).',
  ),
  row(
    'RUNTIME_PROXY_BYPASS',
    'unset: none',
    'Comma-separated hosts a proxied sandbox reaches directly, such as the gateway (`docker`, `kubernetes`, `cloud-run-service`).',
  ),
  row(
    'GATEWAY_PUBLIC_URL',
    'unset: empty',
    'The gateway URL a hosted sandbox calls (`external`, `vercel-sandbox`, `cloudflare-sandbox`); its host is the only one a `none` sandbox reaches.',
  ),
  row(
    'RUNTIME_NETWORK',
    '`agent-egress` on `docker`; none on `cloud-run-service`',
    'The network sandboxes join. `cloud-run-service` needs it with `RUNTIME_SUBNETWORK` or stops start-up; on `docker` a blank value stops start-up.',
  ),
  row(
    'COMPOSE_PROJECT_NAME',
    'unset: containers get no project label',
    '`docker`: the Compose project the manager labels its sandboxes with.',
  ),
  row(
    'RUNTIME_PUBLISH',
    'unset: sandboxes are addressed by name',
    '`docker`: `loopback` publishes each sandbox port on 127.0.0.1, for a manager on the host. Any other value stops start-up.',
  ),
  row(
    'AGENT_WORKSPACE_TOOL_NETWORK',
    '`agent-workspace-tool-sandbox`',
    '`docker`: the network tool sandboxes and the gateway share. A blank value stops start-up.',
  ),
  row(
    'GCP_PROJECT',
    'none: start-up stops on `cloud-run-service`',
    '`cloud-run-service`: the Google Cloud project.',
  ),
  row(
    'GCP_REGION',
    'none: start-up stops on `cloud-run-service`',
    '`cloud-run-service`: the region sandboxes are deployed to.',
  ),
  row(
    'RUNTIME_SERVICE_ACCOUNT',
    'none: start-up stops on `cloud-run-service`',
    '`cloud-run-service`: the service account each sandbox runs as.',
  ),
  row(
    'RUNTIME_SUBNETWORK',
    'none: start-up stops on `cloud-run-service`',
    '`cloud-run-service`: the subnetwork sandboxes join, with `RUNTIME_NETWORK`.',
  ),
  row(
    'RUNTIME_VPC_CONNECTOR',
    'unset',
    '`cloud-run-service`: no longer supported; a value stops start-up and names the replacement.',
  ),
  row(
    'RUNTIME_EGRESS',
    'unset',
    '`cloud-run-service`: no longer supported; a value stops start-up and names the replacement.',
  ),
  row(
    'RUNTIME_EGRESS_PROXY_URL',
    'unset: no egress proxy',
    '`cloud-run-service`: the egress proxy sandboxes reach the internet through. Set with `RUNTIME_EGRESS_PROXY_KEY` or start-up stops.',
  ),
  row(
    'RUNTIME_EGRESS_PROXY_KEY',
    'unset: no egress proxy',
    '`cloud-run-service`: the key that signs the credential a sandbox shows the egress proxy.',
  ),
  row(
    'ACA_SESSION_POOL_ENDPOINT',
    'none: start-up stops on `aca-sessions`',
    '`aca-sessions`: the session pool management endpoint, an `https://` URL without credentials, query or fragment.',
  ),
  row(
    'ACA_SESSION_POOL_API_VERSION',
    'unset: the built-in API version',
    '`aca-sessions`: the management API version. A blank value stops start-up.',
  ),
  row(
    'ACA_SESSION_API_VERSION',
    'unset',
    '`aca-sessions`: the older name of `ACA_SESSION_POOL_API_VERSION`, read when that is unset.',
  ),
  row(
    'ACA_SESSION_POOL_NETWORK_STATUS',
    '`EgressDisabled`',
    '`aca-sessions`: `EgressEnabled` or `EgressDisabled`, as the pool is provisioned. Any other value stops start-up.',
  ),
  row(
    'ACA_SESSION_POOL_ENGINE',
    '`claude-agent-sdk`',
    "`aca-sessions`: the one engine the pool's image carries.",
  ),
  row(
    'CLOUDFLARE_SANDBOX_BRIDGE_URL',
    'none: start-up stops on `cloudflare-sandbox`',
    '`cloudflare-sandbox`: the https URL of the bridge Worker.',
  ),
  row(
    'EXTERNAL_PROVIDER',
    'none: start-up stops on `external`',
    '`external`: the sandbox provider; only `e2b`.',
  ),
  row(
    'E2B_PLAN_TIER',
    '`hobby`',
    '`external`: the E2B plan, `hobby` or `pro`. Any other value stops start-up.',
  ),
  row(
    'VERCEL_PLAN_TIER',
    '`hobby`',
    '`vercel-sandbox`: the Vercel plan, `hobby` or `pro`. Any other value stops start-up.',
  ),
  row(
    'AW_VERCEL_TEAM_ID',
    'unset: `VERCEL_TEAM_ID` is read',
    '`vercel-sandbox`: the team id, under a name outside the `VERCEL_` prefix Vercel reserves.',
  ),
  row(
    'VERCEL_TEAM_ID',
    'none: start-up stops on `vercel-sandbox`',
    '`vercel-sandbox`: the team id, when `AW_VERCEL_TEAM_ID` is unset.',
  ),
  row(
    'AW_VERCEL_PROJECT_ID',
    'unset: `VERCEL_PROJECT_ID` is read',
    '`vercel-sandbox`: the project id, under a name outside the reserved prefix.',
  ),
  row(
    'VERCEL_PROJECT_ID',
    'none: start-up stops on `vercel-sandbox`',
    '`vercel-sandbox`: the project id, when `AW_VERCEL_PROJECT_ID` is unset.',
  ),
  row(
    'RUNTIME_KUBERNETES_NAMESPACE',
    'none: start-up stops on `kubernetes`',
    "`kubernetes`: the manager's own namespace, where sandbox pods are created.",
  ),
  row(
    'RUNTIME_GATEWAY_SERVICE',
    'none: start-up stops on `kubernetes`',
    '`kubernetes`: the Service name sandboxes reach the gateway by.',
  ),
  row(
    'KUBERNETES_SERVICE_HOST',
    'none: start-up stops on `kubernetes`',
    '`kubernetes`: set by the cluster in every pod; its absence means the manager is not in a pod.',
  ),
  row(
    'RUNTIME_CLASS_NAME',
    'unset: the cluster default',
    '`kubernetes`: the RuntimeClass sandbox pods run under, such as gVisor.',
  ),
];

export const SERVED_RUNTIME_DRIVERS = [
  'docker',
  'cloud-run-service',
  'aca-sessions',
  'external',
  'vercel-sandbox',
  'cloudflare-sandbox',
  'kubernetes',
] as const satisfies readonly RuntimeDriverId[];

/**
 * A `RUNTIME_DRIVER` this manager does not serve (#818). It is refused before any driver is built,
 * because falling back to Docker would run sandboxes under a different label than the operator
 * chose. The message names the served ids and not the value; `driver` carries the value for logs.
 */
export class RuntimeDriverConfigurationError extends Error {
  constructor(readonly driver: string) {
    super(
      `runner manager: RUNTIME_DRIVER is not a served driver; use one of ${SERVED_RUNTIME_DRIVERS.join(', ')}, or leave it unset for docker.`,
    );
    this.name = 'RuntimeDriverConfigurationError';
  }
}

/** Thrown at start-up, listing every refused setting at once. */
export class RunnerManagerSettingsError extends Error {
  override readonly name = 'RunnerManagerSettingsError';

  /** One sentence per refused setting, each naming its variable. */
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(`Runner manager start-up stopped on invalid settings. ${reasons.join(' ')}`);
    this.reasons = reasons;
  }
}

/**
 * The log fields for a manager that could not start: one field per refused setting for a
 * {@link RunnerManagerSettingsError}, since the logger cuts a string field at 200 characters; the
 * error itself otherwise.
 */
export function startFailureFields(error: unknown): Readonly<Record<string, unknown>> {
  return error instanceof RunnerManagerSettingsError ? { refused: error.reasons } : { error };
}

/** Exported for the suite. Unset or blank selects Docker; an id the manager does not serve throws. */
export function managerDriverOptions(
  env: SettingsEnvironment,
  docker?: DockerCommand,
): DriverOptions {
  const driver = env['RUNTIME_DRIVER']?.trim() ?? '';
  if (driver === 'external') return externalDriverOptions(env);
  if (driver === 'vercel-sandbox') return vercelSandboxDriverOptions(env);
  if (env['RUNNER_MANAGER_STATELESS']?.trim()) {
    throw new Error(
      'runner manager: RUNNER_MANAGER_STATELESS is served by the external and vercel-sandbox drivers only (ADR-0126).',
    );
  }
  if (driver === 'cloud-run-service') return cloudRunDriverOptions(env);
  if (driver === 'aca-sessions') return acaSessionsDriverOptions(env);
  if (driver === 'cloudflare-sandbox') return cloudflareSandboxDriverOptions(env);
  if (driver === '' || driver === 'docker') return dockerDriverOptions(env, docker);
  if (driver === 'kubernetes') return kubernetesDriverOptions(env);
  throw new RuntimeDriverConfigurationError(driver);
}

/**
 * `RUNTIME_VERIFICATION_TIMEOUT_MS`: unset keeps the 30-second default; otherwise a whole number of
 * milliseconds from 1. Before, any text was passed through `Number()`, so a typo became `NaN` and
 * every readiness check timed out at once.
 */
export function parseVerificationTimeoutMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  const ms = /^\d+$/u.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(ms) || ms < 1) {
    throw new Error(
      'RUNTIME_VERIFICATION_TIMEOUT_MS must be a whole number of milliseconds from 1.',
    );
  }
  return ms;
}

/** `RUNNER_MANAGER_TOKEN`, as given: it is a key, so it is not trimmed, and never repeated. */
function parseManagerToken(value: string | undefined): string {
  if (value === undefined || value.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `RUNNER_MANAGER_TOKEN must contain at least ${String(MIN_TOKEN_LENGTH)} characters.`,
    );
  }
  return value;
}

/** `PORT`: `0` asks the system for a free port (the embedded local runtime does). */
function parseManagerPort(value: string | undefined): number {
  return value?.trim() === '0' ? 0 : parsePort(value ?? DEFAULT_PORT);
}

type Outcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

function attempt<T>(parse: () => T): Outcome<T> {
  try {
    return { ok: true, value: parse() };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export interface RunnerManagerSettings {
  readonly options: RunnerManagerOptions;
  /** The Docker reap a shutdown runs, if the driver has one. */
  readonly reap: DriverOptions['reap'];
}

export interface RunnerManagerListenSettings {
  readonly host: string;
  readonly port: number;
}

/** Parsed settings, or every reason a value was refused. */
type Collected<T> =
  | { readonly value: T; readonly refused?: undefined }
  | { readonly value?: undefined; readonly refused: readonly string[] };

function reasonsOf(outcomes: readonly Outcome<unknown>[]): string[] {
  return outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome.reason]));
}

function managerSettingsOf(
  env: SettingsEnvironment,
  docker: DockerCommand | undefined,
): Collected<RunnerManagerSettings> {
  const token = attempt(() => parseManagerToken(env['RUNNER_MANAGER_TOKEN']));
  const timeout = attempt(() => parseVerificationTimeoutMs(env['RUNTIME_VERIFICATION_TIMEOUT_MS']));
  const driver = attempt(() => managerDriverOptions(env, docker));
  if (!token.ok || !timeout.ok || !driver.ok) {
    return { refused: reasonsOf([token, timeout, driver]) };
  }
  const { reap, ...driverOptions } = driver.value;
  return {
    value: {
      reap,
      options: {
        token: token.value,
        workspacesRoot: env['RUNTIME_WORKSPACES_ROOT'] ?? DEFAULT_WORKSPACES_ROOT,
        ...driverOptions,
        ...(timeout.value === undefined ? {} : { verificationTimeoutMs: timeout.value }),
      },
    },
  };
}

/**
 * The manager's options from its environment. Throws {@link RunnerManagerSettingsError} naming each
 * refused setting; the Vercel Function entry calls this, since it does not listen.
 */
export function readRunnerManagerOptions(
  env: SettingsEnvironment,
  docker?: DockerCommand,
): RunnerManagerSettings {
  const manager = managerSettingsOf(env, docker);
  if (manager.refused !== undefined) throw new RunnerManagerSettingsError(manager.refused);
  return manager.value;
}

/**
 * Every setting `startRunnerManager` needs, parsed together so a bad `PORT` and a bad driver
 * setting are named in one error, before the manager listens.
 */
export function readRunnerManagerSettings(
  env: SettingsEnvironment,
  docker?: DockerCommand,
): RunnerManagerSettings & { readonly listen: RunnerManagerListenSettings } {
  const port = attempt(() => parseManagerPort(env['PORT']));
  const manager = managerSettingsOf(env, docker);
  if (!port.ok || manager.refused !== undefined) {
    throw new RunnerManagerSettingsError([...reasonsOf([port]), ...(manager.refused ?? [])]);
  }
  return { ...manager.value, listen: { host: env['HOST'] ?? DEFAULT_HOST, port: port.value } };
}
