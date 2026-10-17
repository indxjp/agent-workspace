/**
 * The development-only embedded workspace (`pnpm start:embedded`): web, gateway and runner in one
 * Node process over an embedded PostgreSQL and local files.
 *
 * It lives here, in a private package, rather than in `@indx-workspace/cli`, because it imports
 * the server itself (`core`, `gateway`, `runner`, `web`). Those members are private and keep their
 * workspace scope, which a third party owns on npm, so the published CLI must not name them
 * (ADR-0082's amendment for #364). A published CLI starts the Compose project instead.
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { prepareDatabase } from '@agent-workspace/core/db';
import { startGateway } from '@agent-workspace/gateway/start';
import { startRunner } from '@agent-workspace/runner/start';
import { startWeb, type StartWebOptions } from '@agent-workspace/web/server/start';
import {
  assertServerServesContracts,
  detectHostCapabilities,
  type HostCapabilities,
} from '@indx-workspace/cli';
import {
  LOCAL_RUNTIME_GATEWAY_PORT,
  LOCAL_RUNTIME_RUNNER_PORT,
} from '@indx-workspace/contracts/project-file';

import { dockerGatewayHost, startDockerSandbox, type DockerSandbox } from './docker-sandbox.js';
import { resolveEmbeddedDatabasePort, startEmbeddedDatabase } from './embedded-db.js';
import { LAUNCHER_SIGNALS } from './launcher-signals.js';

interface Closeable {
  close(): Promise<void>;
}

const managedEnvironmentKeys = [
  'DATABASE_URL',
  'SESSION_SECRET',
  'MASTER_ENCRYPTION_KEY',
  'GATEWAY_TOKEN_SECRET',
  'AW_FILE_STORAGE_ROOT',
  'AW_SKILL_STORAGE_ROOT',
  'AW_SESSION_TRANSCRIPT_ROOT',
  'RUNNER_WORKSPACE_ROOT',
  'RUNTIME_DRIVER',
  'AW_SESSION_MIRROR_URL',
  'RUNNER_URL',
  'MODEL_GATEWAY_URL',
  'RUNNER_MANAGER_URL',
  'RUNNER_MANAGER_TOKEN',
  'RUNTIME_VERIFICATION_NETWORK_POLICY',
] as const;

/** Where the local runner keeps each session's working directory, under the project. */
export const LOCAL_RUN_WORKSPACE_ROOT = '.agent-workspace/workspaces';

type ManagedEnvironmentKey = (typeof managedEnvironmentKeys)[number];
type EnvironmentSnapshot = ReadonlyMap<ManagedEnvironmentKey, string | undefined>;

function captureEnvironment(): EnvironmentSnapshot {
  return new Map(managedEnvironmentKeys.map((key) => [key, process.env[key]] as const));
}

function restoreEnvironment(snapshot: EnvironmentSnapshot): void {
  for (const key of managedEnvironmentKeys) {
    const value = snapshot.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function closeAll(resources: readonly (Closeable | null)[]): Promise<void> {
  const outcomes = await Promise.allSettled(
    resources
      .filter((resource): resource is Closeable => resource !== null)
      .map(async (resource) => resource.close()),
  );
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason as unknown] : [],
  );

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Workspace shutdown failed.');
  }
}

/**
 * How the workspace runs its web server. The contributor path (`pnpm start:embedded`) passes
 * nothing: Next development mode from `apps/web`. The published launcher passes the production
 * build in `dist/web` (ADR-0109).
 */
export interface WorkspaceOptions {
  readonly web?: StartWebOptions;
}

async function closeServicesThenDatabase(
  services: readonly (Closeable | null)[],
  database: Closeable | null,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await closeAll(services);
  } catch (error) {
    failures.push(error);
  }
  try {
    await closeAll([database]);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Workspace shutdown failed.');
}

/**
 * Load `file` (by default `.env` in the working directory) into `process.env` when it exists.
 * A missing file is not an error: the published runtime starts in a project that may have none,
 * and the variables can come from the environment alone. Any other failure (unreadable, a
 * directory) is thrown.
 */
export function loadDotEnv(file = '.env'): void {
  try {
    process.loadEnvFile(file);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
}

interface RuntimeStartupReport {
  readonly stdout: string;
  readonly warnNoIsolation: boolean;
}

/**
 * The startup lines for the runtime driver that actually runs (#476). Without `RUNTIME_DRIVER`
 * the line names the host's default driver, exactly as before. When `RUNTIME_DRIVER` was set (for
 * example `local` by the local launcher) the line names that driver and, when it differs, the host
 * default on a second line. A blank `RUNTIME_DRIVER` counts as unset and a padded one is trimmed,
 * as the web composition reads it, so the line and the warning name the driver that runs. The
 * driver value is not otherwise validated here: the runner owns that.
 */
function runtimeStartupReport(
  capabilities: HostCapabilities,
  effectiveDriver: string,
  requested: boolean,
): RuntimeStartupReport {
  const reason = capabilities.drivers.find(({ id }) => id === effectiveDriver)?.reason;
  const warnNoIsolation = effectiveDriver === 'local';
  if (!requested) {
    return { stdout: `Runtime: ${effectiveDriver} — ${reason ?? 'detected'}\n`, warnNoIsolation };
  }
  const reasonSuffix = reason === undefined ? '' : `; ${reason}`;
  const hostDefaultLine =
    effectiveDriver === capabilities.defaultDriver
      ? ''
      : `Host default: ${capabilities.defaultDriver}\n`;
  return {
    stdout: `Runtime: ${effectiveDriver} — requested by RUNTIME_DRIVER${reasonSuffix}\n${hostDefaultLine}`,
    warnNoIsolation,
  };
}

/**
 * A started embedded workspace. Annotated rather than inferred: the inferred type names core's
 * `SeedResult`, which `@agent-workspace/core/db` does not export, so declaration emit
 * (`build-contributor`) failed with TS2883.
 */
export interface RunningWorkspace {
  readonly url: string;
  readonly capabilities: HostCapabilities;
  readonly seed: Awaited<ReturnType<typeof prepareDatabase>>;
  close(): Promise<void>;
}

export async function startWorkspace(options: WorkspaceOptions = {}): Promise<RunningWorkspace> {
  loadDotEnv();
  const environmentSnapshot = captureEnvironment();
  const capabilities = detectHostCapabilities();
  let database: Awaited<ReturnType<typeof startEmbeddedDatabase>> | null = null;
  let runner: Awaited<ReturnType<typeof startRunner>> | null = null;
  let sandbox: DockerSandbox | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  let web: Awaited<ReturnType<typeof startWeb>> | null = null;
  let seed: Awaited<ReturnType<typeof prepareDatabase>>;

  try {
    database = process.env['DATABASE_URL']
      ? null
      : await startEmbeddedDatabase(
          process.env['AW_DATA_DIR'],
          resolveEmbeddedDatabasePort(process.env),
        );
    if (database !== null) process.env['DATABASE_URL'] = database.url;

    process.env['SESSION_SECRET'] ??= randomBytes(32).toString('hex');
    process.env['MASTER_ENCRYPTION_KEY'] ??= randomBytes(32).toString('hex');
    process.env['GATEWAY_TOKEN_SECRET'] ??= randomBytes(32).toString('hex');
    process.env['AW_FILE_STORAGE_ROOT'] ??= '.agent-workspace/storage/files';
    process.env['AW_SKILL_STORAGE_ROOT'] ??= '.agent-workspace/storage/skills';
    process.env['AW_SESSION_TRANSCRIPT_ROOT'] ??= '.agent-workspace/storage/sessions';
    // The web side puts each run's `cwd` under this root and the runner creates it. Unset, it is
    // `/workspace`, a container path: on a host the runner's user cannot create it, so every local
    // run was refused with HTTP 422 before it started (S1-19). Absolute, because it becomes a cwd.
    process.env['RUNNER_WORKSPACE_ROOT'] ??= path.resolve(LOCAL_RUN_WORKSPACE_ROOT);
    const requestedDriver = process.env['RUNTIME_DRIVER']?.trim() ?? '';
    // `sandbox-runtime` never had an implementation. Projects and env files that still name it keep
    // starting, but on `local`, and the session says so instead of claiming a sandbox (#818).
    const unimplementedDriver = requestedDriver === 'sandbox-runtime';
    if (unimplementedDriver) {
      process.stderr.write(
        'sandbox-runtime is not implemented; this session runs on local with no isolation.\n',
      );
    }
    const runtimeDriverRequested = requestedDriver.length > 0 && !unimplementedDriver;
    const effectiveDriver = unimplementedDriver
      ? 'local'
      : runtimeDriverRequested
        ? requestedDriver
        : capabilities.defaultDriver;
    process.env['RUNTIME_DRIVER'] = effectiveDriver;
    process.env['AW_SESSION_MIRROR_URL'] ??= `http://127.0.0.1:${process.env['PORT'] ?? '3000'}`;

    // No stray `General` agent: it has no runtime profile and fails when started (issue #692).
    seed = await prepareDatabase(process.env, { general: false });

    const runtimeReport = runtimeStartupReport(
      capabilities,
      effectiveDriver,
      runtimeDriverRequested,
    );
    if (runtimeReport.warnNoIsolation) {
      process.stderr.write(
        'WARNING: local runtime has no tenant isolation; commands run as you.\n',
      );
    }
    process.stdout.write(runtimeReport.stdout);

    // `aw dev --sandbox docker` (#786): runs go to a runner manager on the docker driver, which the
    // web reaches as in any deployment, and a sandbox reaches the gateway through the host. There
    // is no fallback: a sandbox that cannot start fails the start here, never runs on `local`. Only
    // a requested docker starts it; a host that merely has Docker keeps today's default.
    let gatewayHost = '127.0.0.1';
    let gatewayOrigin = 'http://127.0.0.1';
    if (runtimeDriverRequested && effectiveDriver === 'docker') {
      gatewayHost = await dockerGatewayHost();
      gatewayOrigin = 'http://host.docker.internal';
      sandbox = await startDockerSandbox(process.env);
      process.env['RUNNER_MANAGER_URL'] = sandbox.url;
      process.env['RUNNER_MANAGER_TOKEN'] = sandbox.token;
      // The docker profile is `open`; a Test Runtime from the Runtimes page verifies the same.
      process.env['RUNTIME_VERIFICATION_NETWORK_POLICY'] = 'open';
    }
    runner = await startRunner({
      ...process.env,
      PORT: process.env['RUNNER_PORT'] ?? String(LOCAL_RUNTIME_RUNNER_PORT),
      HOST: '127.0.0.1',
    });
    process.env['RUNNER_URL'] = runner.url;
    gateway = await startGateway({
      ...process.env,
      PORT: process.env['GATEWAY_PORT'] ?? String(LOCAL_RUNTIME_GATEWAY_PORT),
      HOST: gatewayHost,
    });
    process.env['MODEL_GATEWAY_URL'] = `${gatewayOrigin}:${String(gateway.port)}`;
    web = await startWeb({ ...process.env, PORT: process.env['PORT'] ?? '3000' }, options.web);
  } catch (startupError) {
    let cleanupFailure: { readonly error: unknown } | undefined;
    try {
      await closeServicesThenDatabase([web, gateway, runner, sandbox], database);
    } catch (error) {
      cleanupFailure = { error };
    } finally {
      restoreEnvironment(environmentSnapshot);
    }

    if (cleanupFailure !== undefined) {
      throw new AggregateError(
        [startupError, cleanupFailure.error],
        'Workspace startup failed and acquired resources could not be fully released.',
        { cause: startupError },
      );
    }
    throw startupError;
  }

  const close = async () => {
    try {
      await closeServicesThenDatabase([web, gateway, runner, sandbox], database);
    } finally {
      restoreEnvironment(environmentSnapshot);
    }
  };
  return { url: web.url, close, capabilities, seed };
}

/**
 * Start the embedded workspace, refuse it (and stop it) when its server does not serve this CLI's
 * contracts version, and keep it running until a launcher signal (SIGINT, SIGTERM, SIGHUP, SIGBREAK).
 */
export async function runEmbeddedCommand(options: WorkspaceOptions = {}): Promise<void> {
  const running = await startWorkspace(options);
  try {
    await assertServerServesContracts(running.url);
  } catch (error) {
    await running.close();
    throw error;
  }
  process.stdout.write(`Agent Workspace is ready at ${running.url}
`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void running.close().then(() => process.exit(0));
  };
  // SIGHUP and SIGBREAK too: their default action skips the `exit` backstop and would leave the
  // detached postmaster running (S1-25, ADR-0112).
  for (const signal of LAUNCHER_SIGNALS) process.on(signal, stop);
}
