import { type LauncherDatabaseRoot, type LocalLauncherDeps } from './launcher-contract.js';
import { createLauncherStartup, failLauncher, startLauncher } from './launcher-startup.js';

// `launch.ts` reaches this module through its one dynamic import of the launcher; the preparation
// imports only types from core, so re-exporting it adds no server code to the bundle's entry.
export { loopbackPortState } from './embedded-db.js';
export { prepareLocalRuntimeProfile } from './local-runtime-profile.js';

export type { LauncherSignal } from './launcher-signals.js';

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
  const context = createLauncherStartup(deps);
  try {
    await startLauncher(context);
    return 0;
  } catch (error) {
    return failLauncher(context, error);
  }
}

export type { LocalLauncherDeps } from './launcher-contract.js';

export {
  localDatabaseUrl,
  runtimeProfileConflictWarning,
  runtimeProfileUnenforceableWarning,
  signInLine,
} from './launcher-setup.js';
