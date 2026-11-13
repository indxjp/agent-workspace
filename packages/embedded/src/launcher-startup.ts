import type { LauncherProject, LauncherStartupContext } from './launcher-contract.js';

import { authorizeLauncherWorkspace } from './launcher-authorization.js';
import { type LauncherDatabaseRoot, type LocalLauncherDeps } from './launcher-contract.js';
import {
  createLauncherLifecycle,
  DEFAULT_STOP_GRACE_MS,
  type Interruption,
  isInterruption,
  settledWithin,
  untilInterrupted,
} from './launcher-lifecycle.js';
import {
  assertLauncherPortsFree,
  prepareLauncherEnvironment,
  readyMessage,
  requestedSandbox,
  signInLine,
} from './launcher-setup.js';
import { LAUNCHER_SIGNALS } from './launcher-signals.js';
import {
  collisionPort,
  failureMessage,
  LocalLauncherError,
  receiveStartMessage,
  sendChildMessage,
} from './runtime-messages.js';

/**
 * How long the whole start may take once `start` arrived. A first start initialises PostgreSQL,
 * runs every migration and loads the Next build, so this is generous; it exists so a step that
 * never settles is reported as `failed` instead of leaving `aw dev` waiting for good.
 */
const DEFAULT_STARTUP_TIMEOUT_MS = 300_000;

export function createLauncherStartup<Directory, Root extends LauncherDatabaseRoot<Directory>>(
  deps: LocalLauncherDeps<Directory, Root>,
): LauncherStartupContext<Directory, Root> {
  const lifecycle = createLauncherLifecycle(deps);
  const interrupt = new AbortController();
  const context: LauncherStartupContext<Directory, Root> = {
    deps,
    lifecycle,
    interrupt,
    pending: Promise.resolve(),
    deadline: undefined,
    foreignHolder: undefined,
    started: false,
    step: <T>(work: Promise<T>): Promise<T> => {
      context.pending = work.then(
        () => undefined,
        () => undefined,
      );
      return untilInterrupted(work, interrupt.signal);
    },
    requestStop: () => {
      if (context.started) void lifecycle.stop();
      else interrupt.abort('stop' satisfies Interruption);
    },
  };
  for (const signal of LAUNCHER_SIGNALS) deps.onSignal(signal, context.requestStop);
  return context;
}

async function prepareLauncherProject<Directory, Root extends LauncherDatabaseRoot<Directory>>(
  context: LauncherStartupContext<Directory, Root>,
) {
  const { deps, interrupt, requestStop } = context;
  const { state, lock } = context.lifecycle;
  const start = await receiveStartMessage(deps.channel, {
    timeoutMs: deps.startTimeoutMs,
    signal: interrupt.signal,
  });
  deps.channel.onDisconnect(requestStop);
  context.deadline = setTimeout(() => {
    interrupt.abort('deadline' satisfies Interruption);
  }, deps.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);

  const { projectDir } = start;
  const { secrets, fromFile } = prepareLauncherEnvironment(deps, start);

  // Diagnosis only: a recorded live holder never refuses the start, it only words a collision.
  context.foreignHolder = lock.liveHolder(projectDir);
  if (context.foreignHolder === undefined) {
    lock.acquire(projectDir);
    state.lockedProjectDir = projectDir;
  }

  return {
    start,
    signInSecrets: {
      path: secrets.path,
      passwordFromFile: fromFile.includes('BOOTSTRAP_ADMIN_PASSWORD'),
    },
  };
}

async function openLauncherServices<Directory, Root extends LauncherDatabaseRoot<Directory>>(
  context: LauncherStartupContext<Directory, Root>,
  project: LauncherProject,
) {
  const { deps, step } = context;
  const { state, lock } = context.lifecycle;
  const { start } = project;
  const { projectDir } = start;
  await assertLauncherPortsFree(deps, start, step);

  const sandbox = requestedSandbox(deps.env);
  // Unset, startWorkspace names the host's default (docker where Docker answers) in its startup
  // line and every page's driver banner, while runs use the local profile (BH061-050).
  if ((deps.env['RUNTIME_DRIVER']?.trim() ?? '') === '') deps.env['RUNTIME_DRIVER'] = sandbox;
  const workspace = await step(
    deps.startWorkspace({ web: { dir: deps.webDir, dev: false } }).then((value) => {
      state.running = value;
      deps.claimSignals();
      return value;
    }),
  );
  if (context.foreignHolder !== undefined) {
    // Every service is bound, so the recorded process does not run this project's runtime: the
    // record is stale (its pid reused by an unrelated process). Replace it, so the next start
    // names this process and a stop removes the record (issue #560).
    context.foreignHolder = undefined;
    lock.acquire(projectDir);
    state.lockedProjectDir = projectDir;
  }
  try {
    await step(deps.assertServerServesContracts(workspace.url));
  } catch (error) {
    if (isInterruption(error)) throw error;
    throw new LocalLauncherError('contracts_skew', { cause: error });
  }

  await step(sendChildMessage(deps.channel, readyMessage(workspace.url, deps.env)));

  const database = await step(
    deps.openDatabaseRoot(deps.env).then((value) => {
      state.root = value;
      return value;
    }),
  );
  return { workspace, database, sandbox };
}

export async function startLauncher<Directory, Root extends LauncherDatabaseRoot<Directory>>(
  context: LauncherStartupContext<Directory, Root>,
): Promise<void> {
  const { deps } = context;
  const project = await prepareLauncherProject(context);
  const services = await openLauncherServices(context, project);
  const { email } = await authorizeLauncherWorkspace(context, project, services);
  const { workspace } = services;
  clearTimeout(context.deadline);
  context.started = true;

  deps.stdout(signInLine(workspace.url, email, project.signInSecrets));
}

export async function failLauncher<Directory, Root extends LauncherDatabaseRoot<Directory>>(
  context: LauncherStartupContext<Directory, Root>,
  error: unknown,
): Promise<number> {
  const { deps, interrupt, pending } = context;
  const { lifecycle } = context;
  clearTimeout(context.deadline);
  if (interrupt.signal.aborted) {
    // What the abandoned step still acquires is released with the rest, if it arrives in time.
    await settledWithin(pending, deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS);
  }
  if (interrupt.signal.reason === 'stop') {
    await lifecycle.stop();
    return 0;
  }
  const collidedPort = collisionPort(error);
  const message = failureMessage(
    context.foreignHolder !== undefined && collidedPort !== undefined
      ? new LocalLauncherError('already_running', {
          cause: error,
          pid: context.foreignHolder,
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
    await lifecycle.release();
  } catch {
    deps.stderr('warning: the local runtime could not release everything it started\n');
  }
  return 1;
}
