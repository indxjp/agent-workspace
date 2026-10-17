/**
 * The published local runtime's entry (`dist/launch.js`, ADR-0109): web, gateway and runner in one
 * Node process, with the production Next build in `dist/web` and the migrations in
 * `dist/migrations` beside this file.
 *
 * It statically imports nothing that reaches server code. `./workspace.js`, and through it every
 * inlined server module, is loaded by a dynamic `import()`, which the bundler turns into a lazy
 * initialiser, so the argv guard below runs before any inlined module's top level.
 */
import type { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

import { LAUNCHER_SIGNALS, type LauncherSignal } from './launcher-signals.js';
import { isMainModule } from './main-module.js';
import { NEXT_STANDALONE_CONFIG_ENV, standaloneNextConfig } from './next-config.js';

/** What the bundle prints, on stderr, when it is run directly instead of through `dist/bin.js`. */
export const BUNDLE_ENTRY_REFUSAL = 'run dist/bin.js, not the bundle';

/**
 * Whether `entry` (normally `process.argv[1]`) resolves, through any symlink, to the bundle
 * `moduleUrl` names. The inlined servers each test `argv[1]` against their own `import.meta.url`,
 * which is the bundle's, so running the bundle directly would start them twice.
 */
export function isBundleEntry(entry: string | undefined, moduleUrl: string): boolean {
  return isMainModule(entry, moduleUrl);
}

function refuseBundleEntry(): number {
  process.stderr.write(`${BUNDLE_ENTRY_REFUSAL}\n`);
  return 1;
}

if (isBundleEntry(process.argv[1], import.meta.url)) process.exitCode = refuseBundleEntry();

/** How the runtime was started: forked by `aw dev` with an IPC channel, or directly. */
export type LaunchMode = 'ipc' | 'environment';

/**
 * `ipc` exactly when the process has an IPC channel: `sendType` is `typeof process.send`, which is
 * `'function'` only when the process was forked with one.
 */
export function selectLaunchMode(sendType: string): LaunchMode {
  return sendType === 'function' ? 'ipc' : 'environment';
}

/** The launcher's `onSignal` and `claimSignals` over `target` (`process` in production). */
export interface SignalOwner {
  readonly on: (signal: LauncherSignal, listener: () => void) => void;
  /** Drop every listener for a launcher signal on `target` except the ones added through `on`. */
  readonly claim: () => void;
}

export function signalOwner(target: EventEmitter): SignalOwner {
  const owned: { readonly signal: LauncherSignal; readonly listener: () => void }[] = [];
  return {
    on: (signal, listener) => {
      owned.push({ signal, listener });
      target.on(signal, listener);
    },
    claim: () => {
      for (const signal of LAUNCHER_SIGNALS) target.removeAllListeners(signal);
      for (const { signal, listener } of owned) target.on(signal, listener);
    },
  };
}

function distPath(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

/**
 * The `aw dev` path (S1-11, #449): run the launcher over this process's IPC channel. Every server
 * module is reached through a dynamic `import()`, so it stays a lazy initialiser in the bundle.
 */
async function runIpcLauncher(): Promise<number> {
  const [
    { loopbackPortState, prepareLocalRuntimeProfile, runLocalLauncher },
    { processChannel },
    workspace,
    cli,
    db,
    credential,
  ] = await Promise.all([
    import('./local-launcher.js'),
    import('./runtime-messages.js'),
    import('./workspace.js'),
    import('@indx-workspace/cli'),
    import('@agent-workspace/core/db'),
    import('@agent-workspace/web/server/cli-auth/local-credential'),
  ]);
  const signals = signalOwner(process);
  return runLocalLauncher({
    channel: processChannel(),
    env: process.env,
    stdout: (chunk) => void process.stdout.write(chunk),
    stderr: (chunk) => void process.stderr.write(chunk),
    chdir: (directory) => {
      process.chdir(directory);
    },
    loadDotEnv: workspace.loadDotEnv,
    portState: loopbackPortState,
    startWorkspace: workspace.startWorkspace,
    assertServerServesContracts: (url) => cli.assertServerServesContracts(url),
    openDatabaseRoot: db.openDatabaseRoot,
    prepareLocalRuntimeProfile,
    issueLocalCredential: credential.issueLocalApiKey,
    onSignal: signals.on,
    claimSignals: signals.claim,
    exit: (code) => process.exit(code),
    webDir: distPath('./web'),
    migrationsDir: distPath('./migrations'),
  });
}

/**
 * Start the local runtime from the built package: migrations from `dist/migrations` (unless
 * `MIGRATIONS_DIR` is set) and the production Next build from `dist/web`. Forked by `aw dev` with
 * an IPC channel, it runs the launcher protocol; run directly, it is configured by the environment
 * alone. Resolves with the exit code once the workspace is ready, or has failed to start; the
 * servers keep the process alive.
 */
export async function runLocalRuntime(): Promise<number> {
  if (isBundleEntry(process.argv[1], import.meta.url)) return refuseBundleEntry();
  // The package carries only Next's traced server files (dist/node_modules), not the build-time
  // modules that loading next.config reaches, so Next is handed the config its build resolved.
  process.env[NEXT_STANDALONE_CONFIG_ENV] = standaloneNextConfig(distPath('./web'));
  if (selectLaunchMode(typeof process.send) === 'ipc') return runIpcLauncher();
  process.env['MIGRATIONS_DIR'] ??= distPath('./migrations');
  const [{ runAsProcess }, { runEmbeddedCommand }] = await Promise.all([
    import('@indx-workspace/cli'),
    import('./workspace.js'),
  ]);
  return runAsProcess(() => runEmbeddedCommand({ web: { dir: distPath('./web'), dev: false } }));
}
