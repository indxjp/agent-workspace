/**
 * S1-11 (#449), ADR-0109: the local runtime launcher `aw dev` forks.
 *
 * It waits for `start`, prepares the project's runtime directory and persisted secrets, applies
 * contract C1, starts the embedded database and the three services, and answers `ready` and then
 * `credential`: a workspace API key for the local workspace, minted in process at a role no higher
 * than the bootstrap admin's (S1-21, issue #500; ADR-0109 as amended), so `aw` can reach every
 * control-plane route it calls without a device grant. On SIGINT, SIGTERM, SIGHUP (a closed
 * terminal or console), SIGBREAK (Windows Ctrl+Break) or the channel closing it revokes that key first, while the database is still up, and then stops everything. Any failure
 * becomes one `failed` message whose text {@link failureMessage} made safe.
 *
 * Before minting the key it prepares the workspace's `local` runtime profile (S1-22, issue #504;
 * ADR-0109 as amended): created or adopted, and made the workspace default unless one is already
 * chosen, so an agent `aw dev` pushes without naming a runtime profile can run.
 *
 * Before starting the services it records its pid in `.agent-workspace/runtime.pid` (issue #560)
 * unless another live process is recorded there, and removes it again on stop or failure. A start
 * that then fails on a port collision while another live process is recorded is reported as
 * `already_running`: the port, and that the runtime may already be running as the recorded process.
 * A pid cannot prove the process is an aw runtime, so a start whose services all bind despite a
 * live record treats the record as stale and replaces it with its own pid.
 *
 * It then checks every port the services will bind and, when any cannot be bound, fails before
 * starting one, naming every such port with its role and the setting that moves it (issue #660).
 *
 * The key travels only over the channel. It is never passed to a writer, a log or a file.
 * Every effect is injected, so the tests drive the whole sequence with fakes.
 */
import { statSync } from 'node:fs';
import path from 'node:path';

import { CONTRACTS_VERSION } from '@indx-workspace/contracts';

import { LAUNCHER_SIGNALS, type LauncherSignal } from './launcher-signals.js';
import type { LoopbackPortState } from './embedded-db.js';
import {
  applyLocalRuntimeEnvironment,
  type BusyLocalRuntimePort,
  localRuntimePorts,
  LocalRuntimePortsBusyError,
} from './local-environment.js';
import type { LocalRuntimeProfileDriver } from './local-runtime-profile.js';
import { applyLocalSecrets, ensureLocalSecrets } from './local-secrets.js';
import { createRuntimeLock, type RuntimeLock } from './runtime-lock.js';
import {
  collisionPort,
  failureMessage,
  LocalLauncherError,
  type LocalRuntimeChannel,
  receiveStartMessage,
  sendChildMessage,
} from './runtime-messages.js';
import type { WorkspaceOptions } from './workspace.js';

// `launch.ts` reaches this module through its one dynamic import of the launcher; the preparation
// imports only types from core, so re-exporting it adds no server code to the bundle's entry.
export { loopbackPortState } from './embedded-db.js';
export { prepareLocalRuntimeProfile } from './local-runtime-profile.js';

/** The workspace slug the seed uses when `WORKSPACE_SLUG` is unset or blank. */
const DEFAULT_WORKSPACE_SLUG = 'default';

/**
 * How long the whole start may take once `start` arrived. A first start initialises PostgreSQL,
 * runs every migration and loads the Next build, so this is generous; it exists so a step that
 * never settles is reported as `failed` instead of leaving `aw dev` waiting for good.
 */
const DEFAULT_STARTUP_TIMEOUT_MS = 300_000;

/** How long a stop during the start waits for the abandoned step to hand back what it acquired. */
const DEFAULT_STOP_GRACE_MS = 10_000;

/** What the launcher needs from a started workspace (`startWorkspace`). */
interface LauncherWorkspace {
  readonly url: string;
  readonly seed: { readonly workspaceId: string; readonly adminUserId: string };
  close(): Promise<void>;
}

/** The bootstrap admin's membership, as `resolveMembership` answers it. */
interface LauncherMembership {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: 'owner' | 'admin' | 'builder' | 'viewer';
}

/** What the launcher needs from the database root (`openDatabaseRoot`). */
interface LauncherDatabaseRoot<Directory> {
  readonly directory: Directory;
  resolveMembership(email: string, workspaceSlug: string): Promise<LauncherMembership | null>;
  close(): Promise<void>;
}

/**
 * What preparing the `local` runtime profile answered (core's `ensureWorkspaceDefault`): `kept`,
 * `adopted` and `created` let the start continue as they are; `name-conflict` and `unenforceable`
 * are warned about, and the start continues with no default. Under the docker sandbox anything but
 * a default on the docker driver refuses the start (#786).
 */
type LauncherRuntimeProfileOutcome =
  | { readonly kind: 'kept' | 'adopted' | 'created'; readonly profile: { readonly driver: string } }
  | { readonly kind: 'name-conflict'; readonly name: string }
  | {
      readonly kind: 'unenforceable';
      readonly name: string;
      readonly settings: readonly string[];
    };

/**
 * The docker sandbox runs only when docker was asked for (#786). Read before `startWorkspace`, which
 * rewrites RUNTIME_DRIVER to the driver that runs: the host's default when none was asked for.
 */
function requestedSandbox(
  env: Readonly<Record<string, string | undefined>>,
): LocalRuntimeProfileDriver {
  return env['RUNTIME_DRIVER']?.trim() === 'docker' ? 'docker' : 'local';
}

/**
 * A docker session whose default is not a docker profile would run its agents elsewhere while
 * saying docker (#786): refuse it rather than warn.
 */
function refuseDockerSessionOffDocker(
  sandbox: LocalRuntimeProfileDriver,
  profile: LauncherRuntimeProfileOutcome,
): void {
  if (sandbox !== 'docker') return;
  if ('profile' in profile && profile.profile.driver === 'docker') return;
  throw new LocalLauncherError('docker_profile_not_default');
}

/** The one stderr line a `name-conflict` writes; the start continues. */
export function runtimeProfileConflictWarning(name: string): string {
  return (
    `warning: a runtime profile named ${JSON.stringify(name)} already uses another driver, so the ` +
    'local runtime chose no default runtime profile; agents that name no runtime profile cannot ' +
    'run until one is chosen\n'
  );
}

/**
 * The one stderr line an `unenforceable` writes: the existing `local` profile asks the in-process
 * runner for settings it cannot enforce, so it was not made the default. The start continues.
 */
export function runtimeProfileUnenforceableWarning(
  name: string,
  settings: readonly string[],
): string {
  return (
    `warning: the runtime profile named ${JSON.stringify(name)} sets ${settings.join(', ')}, which ` +
    'the local runner cannot enforce, so the local runtime chose no default runtime profile; ' +
    'agents that name no runtime profile cannot run until one is chosen\n'
  );
}

/** Whom the credential is issued for; the issuer reads the member's role itself. */
interface LauncherCredentialSubject {
  readonly workspaceId: string;
  readonly userId: string;
}

/** What the launcher needs from an issued credential (`issueLocalApiKey`). */
interface LauncherCredential {
  readonly token: string;
  readonly expiresAt: Date;
  /** `revoked`, `already-revoked`, or `missing` (the row no longer exists). */
  revoke(): Promise<'revoked' | 'already-revoked' | 'missing'>;
}

export type { LauncherSignal } from './launcher-signals.js';

export interface LocalLauncherDeps<
  Directory,
  Root extends LauncherDatabaseRoot<Directory> = LauncherDatabaseRoot<Directory>,
> {
  readonly channel: LocalRuntimeChannel;
  /** The environment the services read; `process.env` in production. */
  readonly env: Record<string, string | undefined>;
  readonly stdout: (chunk: string) => void;
  readonly stderr: (chunk: string) => void;
  readonly chdir: (directory: string) => void;
  /** Loads a `.env` file into the environment when it exists (`loadDotEnv`). */
  readonly loadDotEnv: (file: string) => void;
  /**
   * Whether `127.0.0.1:port` can be bound (`loopbackPortState`). Every port the services will bind
   * is checked before any starts, so all the busy ones are reported together (issue #660).
   */
  readonly portState: (port: number) => Promise<LoopbackPortState>;
  readonly startWorkspace: (options: WorkspaceOptions) => Promise<LauncherWorkspace>;
  readonly assertServerServesContracts: (url: string) => Promise<void>;
  readonly openDatabaseRoot: (env: Readonly<Record<string, string | undefined>>) => Promise<Root>;
  /**
   * Ensure the workspace's `local` runtime profile and make it the default when none is chosen
   * (`prepareLocalRuntimeProfile`, S1-22). Runs after the membership check, before the key.
   */
  readonly prepareLocalRuntimeProfile: (
    workspaceId: string,
    root: Root,
    driver: LocalRuntimeProfileDriver,
  ) => Promise<LauncherRuntimeProfileOutcome>;
  /** Mints the local workspace API key (`issueLocalApiKey`); the key's `revoke` withdraws it. */
  readonly issueLocalCredential: (
    input: LauncherCredentialSubject,
    deps: { readonly directory: Directory },
  ) => Promise<LauncherCredential>;
  readonly onSignal: (signal: LauncherSignal, listener: () => void) => void;
  /**
   * Leave the listeners `onSignal` registered as the only listeners for every {@link LauncherSignal}.
   * Called once the workspace has started: starting it loads `embedded-postgres`, whose `async-exit-hook`
   * stops the database on those signals at the same moment the launcher begins to revoke the
   * credential, so the revocation raced a database already shutting down and could be lost, leaving
   * the token valid on the next start. The launcher's own stop closes the database after revoking.
   */
  readonly claimSignals: () => void;
  readonly exit: (code: number) => void;
  /** The production Next build (`dist/web`). */
  readonly webDir: string;
  /** The shipped migrations (`dist/migrations`). */
  readonly migrationsDir: string;
  readonly startTimeoutMs?: number;
  /** The deadline for the whole start after `start` arrived (default five minutes). */
  readonly startupTimeoutMs?: number;
  /** How long a stop during the start waits for the step in progress (default ten seconds). */
  readonly stopGraceMs?: number;
  /** The project's runtime pid file (issue #560); `createRuntimeLock()` by default. */
  readonly runtimeLock?: RuntimeLock;
}

function assertProjectDirectory(projectDir: string): void {
  if (!path.isAbsolute(projectDir)) throw new LocalLauncherError('invalid_project_dir');
  let isDirectory: boolean;
  try {
    isDirectory = statSync(projectDir).isDirectory();
  } catch (error) {
    throw new LocalLauncherError('invalid_project_dir', { cause: error });
  }
  if (!isDirectory) throw new LocalLauncherError('invalid_project_dir');
}

interface SignInSecrets {
  readonly path: string;
  /** Whether BOOTSTRAP_ADMIN_PASSWORD came from the secrets file rather than the environment or `.env`. */
  readonly passwordFromFile: boolean;
}

/**
 * The one line that tells the person how to sign in to the web UI. It names where the password is,
 * never the password itself: stdout ends up in `.aw/logs/runtime.log` and in redirected
 * background-start logs (BH061-011), while the secrets file is mode 0600. Never carries the token.
 */
export function signInLine(url: string, email: string, secrets: SignInSecrets): string {
  if (!secrets.passwordFromFile) {
    return `Sign in at ${url} as ${email}; the password is BOOTSTRAP_ADMIN_PASSWORD, set in the environment or .env\n`;
  }
  return `Sign in at ${url} as ${email}; the password is in ${secrets.path}\n`;
}

/** Why a pending start step was abandoned: a signal or disconnect, or the startup deadline. */
type Interruption = 'stop' | 'deadline';

/** Thrown out of a start step a stop request abandoned; it is never reported as `failed`. */
class LauncherStopped extends Error {
  constructor() {
    super('the local runtime was stopped before it started');
    this.name = 'LauncherStopped';
  }
}

function interruptionError(signal: AbortSignal): Error {
  return signal.reason === 'deadline'
    ? new LocalLauncherError('startup_timeout')
    : new LauncherStopped();
}

/** `work`, or a rejection as soon as `signal` is aborted, whichever comes first. */
function untilInterrupted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(interruptionError(signal));
  let onAbort: () => void = () => undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(interruptionError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([work, interrupted]).finally(() => {
    signal.removeEventListener('abort', onAbort);
  });
}

/** Resolves when `work` settles or `timeoutMs` passes, whichever is first; never rejects. */
function settledWithin(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    work.then(done, done);
  });
}

function isInterruption(error: unknown): boolean {
  return (
    error instanceof LauncherStopped ||
    (error instanceof LocalLauncherError && error.code === 'startup_timeout')
  );
}

/**
 * Run the launcher until the workspace is serving and `credential` is sent. Resolves with 0 then
 * (the servers keep the process alive, and a later signal or disconnect stops it through
 * `exit(0)`), or with 1 after a failure has been reported as `failed` and everything acquired was
 * released.
 *
 * A signal, or the channel closing, before that point abandons the step in progress at once: the
 * launcher waits at most `stopGraceMs` for that step to hand back what it acquired, releases
 * everything and exits 0. A start that takes longer than `startupTimeoutMs` after `start` arrived
 * is reported as `failed` the same way, so `aw dev` never waits on a runtime that hangs.
 */
export async function runLocalLauncher<
  Directory,
  Root extends LauncherDatabaseRoot<Directory> = LauncherDatabaseRoot<Directory>,
>(deps: LocalLauncherDeps<Directory, Root>): Promise<number> {
  let running: LauncherWorkspace | undefined;
  let root: Root | undefined;
  let credential: LauncherCredential | undefined;
  let started = false;
  let stopping: Promise<void> | undefined;
  let forceExit: ReturnType<typeof setTimeout> | undefined;
  /** The start step in progress, settled either way; what it acquires lands in the fields above. */
  let pending: Promise<unknown> = Promise.resolve();
  const interrupt = new AbortController();
  const lock = deps.runtimeLock ?? createRuntimeLock();
  /** The project whose pid file this launcher wrote, until it removes it again. */
  let lockedProjectDir: string | undefined;
  /** Another live process recorded as this project's runtime when the start began. */
  let foreignHolder: number | undefined;

  const releaseLock = (): void => {
    if (lockedProjectDir === undefined) return;
    lock.release(lockedProjectDir);
    lockedProjectDir = undefined;
  };

  // The order is the contract (S1-06): the key is revoked while the database is still up, then the
  // database connection closes, then the workspace (and with it the embedded database) stops.
  const releaseServices = async (): Promise<void> => {
    const heldCredential = credential;
    credential = undefined;
    if (heldCredential !== undefined) {
      try {
        // `already-revoked` is a person or a later sweep having done it; `missing` is not expected.
        if ((await heldCredential.revoke()) === 'missing') {
          deps.stderr('warning: the local credential was not found to revoke\n');
        }
      } catch {
        deps.stderr('warning: the local credential could not be revoked\n');
      }
    }
    const heldRoot = root;
    root = undefined;
    if (heldRoot !== undefined) {
      try {
        await heldRoot.close();
      } catch {
        deps.stderr('warning: the database connection could not be closed\n');
      }
    }
    const heldWorkspace = running;
    running = undefined;
    if (heldWorkspace !== undefined) await heldWorkspace.close();
  };

  // The pid file goes last, once every service has stopped, and even when one could not.
  const release = async (): Promise<void> => {
    try {
      await releaseServices();
    } finally {
      releaseLock();
    }
  };

  const stop = (): Promise<void> => {
    // A release that hangs (a service that never closes) must not leave a runtime that ignores
    // every signal and spins: after the grace the process exits whatever is still open.
    forceExit ??= setTimeout(() => {
      deps.stderr('warning: the local runtime did not stop within the grace; exiting\n');
      releaseLock();
      deps.exit(1);
    }, deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS);
    stopping ??= release()
      .catch(() => {
        deps.stderr('warning: the local runtime could not stop every service cleanly\n');
      })
      .then(() => {
        clearTimeout(forceExit);
        deps.exit(0);
      });
    return stopping;
  };

  const requestStop = (): void => {
    if (started) void stop();
    else interrupt.abort('stop' satisfies Interruption);
  };
  for (const signal of LAUNCHER_SIGNALS) deps.onSignal(signal, requestStop);

  /** Run one start step so a stop or the deadline abandons it; what it acquires is still kept. */
  const step = <T>(work: Promise<T>): Promise<T> => {
    pending = work.then(
      () => undefined,
      () => undefined,
    );
    return untilInterrupted(work, interrupt.signal);
  };

  let deadline: ReturnType<typeof setTimeout> | undefined;

  try {
    const start = await receiveStartMessage(deps.channel, {
      timeoutMs: deps.startTimeoutMs,
      signal: interrupt.signal,
    });
    deps.channel.onDisconnect(requestStop);
    deadline = setTimeout(() => {
      interrupt.abort('deadline' satisfies Interruption);
    }, deps.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);

    const { projectDir } = start;
    assertProjectDirectory(projectDir);
    deps.chdir(projectDir);

    const secrets = ensureLocalSecrets(projectDir);
    const dotEnv = path.join(projectDir, '.env');
    try {
      deps.loadDotEnv(dotEnv);
    } catch (error) {
      throw new LocalLauncherError('dotenv_unreadable', { cause: error, file: dotEnv });
    }
    const environment = applyLocalRuntimeEnvironment(deps.env, start, {
      migrationsDir: deps.migrationsDir,
    });
    for (const warning of environment.warnings) deps.stderr(`${warning}\n`);
    const fromFile = applyLocalSecrets(deps.env, secrets.secrets);

    // Diagnosis only: a recorded live holder never refuses the start, it only words a collision.
    foreignHolder = lock.liveHolder(projectDir);
    if (foreignHolder === undefined) {
      lock.acquire(projectDir);
      lockedProjectDir = projectDir;
    }

    const checked = await step(
      Promise.all(
        localRuntimePorts(deps.env, start.environment.port).map(async (entry) => ({
          ...entry,
          state: await deps.portState(entry.port),
        })),
      ),
    );
    const busy = checked.flatMap(({ state, ...entry }): BusyLocalRuntimePort[] =>
      state === 'free' ? [] : [{ ...entry, state }],
    );
    const [firstBusy, ...otherBusy] = busy;
    if (firstBusy !== undefined) throw new LocalRuntimePortsBusyError([firstBusy, ...otherBusy]);

    const sandbox = requestedSandbox(deps.env);
    // Unset, startWorkspace names the host's default (docker where Docker answers) in its startup
    // line and every page's driver banner, while runs use the local profile (BH061-050).
    if ((deps.env['RUNTIME_DRIVER']?.trim() ?? '') === '') deps.env['RUNTIME_DRIVER'] = sandbox;
    const workspace = await step(
      deps.startWorkspace({ web: { dir: deps.webDir, dev: false } }).then((value) => {
        running = value;
        deps.claimSignals();
        return value;
      }),
    );
    if (foreignHolder !== undefined) {
      // Every service is bound, so the recorded process does not run this project's runtime: the
      // record is stale (its pid reused by an unrelated process). Replace it, so the next start
      // names this process and a stop removes the record (issue #560).
      foreignHolder = undefined;
      lock.acquire(projectDir);
      lockedProjectDir = projectDir;
    }
    try {
      await step(deps.assertServerServesContracts(workspace.url));
    } catch (error) {
      if (isInterruption(error)) throw error;
      throw new LocalLauncherError('contracts_skew', { cause: error });
    }

    await step(
      sendChildMessage(deps.channel, {
        type: 'ready',
        url: workspace.url,
        contractsVersion: CONTRACTS_VERSION,
      }),
    );

    const database = await step(
      deps.openDatabaseRoot(deps.env).then((value) => {
        root = value;
        return value;
      }),
    );
    const workspaceSlug = deps.env['WORKSPACE_SLUG']?.trim() || DEFAULT_WORKSPACE_SLUG;
    const email = (deps.env['BOOTSTRAP_ADMIN'] ?? start.environment.bootstrapAdmin).toLowerCase();
    const membership = await step(database.resolveMembership(email, workspaceSlug));
    if (
      membership?.workspaceId !== workspace.seed.workspaceId ||
      membership.userId !== workspace.seed.adminUserId
    ) {
      throw new LocalLauncherError('workspace_mismatch');
    }

    let profile: LauncherRuntimeProfileOutcome;
    try {
      profile = await step(
        deps.prepareLocalRuntimeProfile(workspace.seed.workspaceId, database, sandbox),
      );
    } catch (error) {
      if (isInterruption(error)) throw error;
      throw new LocalLauncherError('runtime_profile_not_prepared', { cause: error });
    }
    refuseDockerSessionOffDocker(sandbox, profile);
    if (profile.kind === 'name-conflict') {
      deps.stderr(runtimeProfileConflictWarning(profile.name));
    } else if (profile.kind === 'unenforceable') {
      deps.stderr(runtimeProfileUnenforceableWarning(profile.name, profile.settings));
    }

    const issued = await step(
      deps
        .issueLocalCredential(
          { workspaceId: workspace.seed.workspaceId, userId: workspace.seed.adminUserId },
          { directory: database.directory },
        )
        .then((value) => {
          credential = value;
          return value;
        }),
    );
    await step(
      sendChildMessage(deps.channel, {
        type: 'credential',
        token: issued.token,
        expiresAt: issued.expiresAt.toISOString(),
        workspaceId: workspace.seed.workspaceId,
        workspaceSlug,
      }),
    );
    clearTimeout(deadline);
    started = true;

    deps.stdout(
      signInLine(workspace.url, email, {
        path: secrets.path,
        passwordFromFile: fromFile.includes('BOOTSTRAP_ADMIN_PASSWORD'),
      }),
    );
    return 0;
  } catch (error) {
    clearTimeout(deadline);
    if (interrupt.signal.aborted) {
      // What the abandoned step still acquires is released with the rest, if it arrives in time.
      await settledWithin(pending, deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS);
    }
    if (interrupt.signal.reason === 'stop') {
      await stop();
      return 0;
    }
    const collidedPort = collisionPort(error);
    const message = failureMessage(
      foreignHolder !== undefined && collidedPort !== undefined
        ? new LocalLauncherError('already_running', {
            cause: error,
            pid: foreignHolder,
            port: collidedPort,
          })
        : error,
    );
    try {
      await sendChildMessage(deps.channel, { type: 'failed', message });
    } catch {
      deps.stderr(`${message}\n`);
    }
    try {
      await release();
    } catch {
      deps.stderr('warning: the local runtime could not release everything it started\n');
    }
    return 1;
  }
}
