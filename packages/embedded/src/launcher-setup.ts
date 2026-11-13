import type { LauncherStep } from './launcher-contract.js';

import { statSync } from 'node:fs';
import path from 'node:path';

import { CONTRACTS_VERSION } from '@indx-workspace/contracts';
import {
  LocalRuntimeDatabaseUrlSchema,
  type LocalRuntimeReadyMessage,
  type LocalRuntimeStartMessage,
} from '@indx-workspace/contracts/local-runtime';

import {
  type LauncherDatabaseRoot,
  type LauncherRuntimeProfileOutcome,
  type LocalLauncherDeps,
} from './launcher-contract.js';
import {
  applyLocalRuntimeEnvironment,
  type BusyLocalRuntimePort,
  localRuntimePorts,
  LocalRuntimePortsBusyError,
} from './local-environment.js';
import type { LocalRuntimeProfileDriver } from './local-runtime-profile.js';
import { applyLocalSecrets, ensureLocalSecrets } from './local-secrets.js';
import { LocalLauncherError } from './runtime-messages.js';

/**
 * Issue #1506: the database `ready` names for a local app — the `DATABASE_URL` the workspace runs on
 * (the embedded PostgreSQL's, set by `startWorkspace`) when it is a loopback PostgreSQL URL, and
 * nothing for any other, so a runtime never hands `aw` a remote database.
 */
export function localDatabaseUrl(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const url = env['DATABASE_URL'];
  return url !== undefined && LocalRuntimeDatabaseUrlSchema.safeParse(url).success
    ? url
    : undefined;
}

/** The `ready` message: the workspace's URL, this contracts version, and its local database. */
export function readyMessage(
  url: string,
  env: Readonly<Record<string, string | undefined>>,
): LocalRuntimeReadyMessage {
  const databaseUrl = localDatabaseUrl(env);
  return {
    type: 'ready',
    url,
    contractsVersion: CONTRACTS_VERSION,
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
  };
}

/**
 * The docker sandbox runs only when docker was asked for (#786). Read before `startWorkspace`, which
 * rewrites RUNTIME_DRIVER to the driver that runs: the host's default when none was asked for.
 */
export function requestedSandbox(
  env: Readonly<Record<string, string | undefined>>,
): LocalRuntimeProfileDriver {
  return env['RUNTIME_DRIVER']?.trim() === 'docker' ? 'docker' : 'local';
}

/**
 * A docker session whose default is not a docker profile would run its agents elsewhere while
 * saying docker (#786): refuse it rather than warn.
 */
export function refuseDockerSessionOffDocker(
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

export function prepareLauncherEnvironment<Directory, Root extends LauncherDatabaseRoot<Directory>>(
  deps: LocalLauncherDeps<Directory, Root>,
  start: LocalRuntimeStartMessage,
) {
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

  return { secrets, fromFile };
}

export async function assertLauncherPortsFree<
  Directory,
  Root extends LauncherDatabaseRoot<Directory>,
>(
  deps: LocalLauncherDeps<Directory, Root>,
  start: LocalRuntimeStartMessage,
  step: LauncherStep,
): Promise<void> {
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
}
