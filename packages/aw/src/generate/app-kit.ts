/**
 * Reaching the project's app kit (`@indx-workspace/app`) without importing it (issue #1505). `aw`
 * may import only the SDK and the contracts (`aw-depends-only-on-sdk-and-contracts`), so the
 * work only the app kit can do — a resource's migration SQL — runs in its `aw-app` bin, found in
 * the project's own install the way `resolveLocalRuntime` finds the local runtime, and spawned in
 * a child process with an allowlisted environment.
 */
import { spawn } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  appKitPackages as sdkAppKitPackages,
  type FieldSpec,
  type PinnedPackage,
} from '@indx-workspace/sdk/project';
import { z } from 'zod';

import { CommandRefusedError, UsageError } from '../io.js';
import { findPackageDirectory } from '../local-runtime/resolve.js';
import { errorCode } from '../local-runtime/project.js';
import { AW_VERSION } from '../version.js';

/** The app kit's npm name. `aw` never imports it; it spawns its `aw-app` bin. */
const APP_KIT_PACKAGE = '@indx-workspace/app';

/** The bin of the app kit `aw generate` spawns. */
const APP_KIT_BIN = 'aw-app';

/** The one line that installs the app kit `aw generate app` added to `package.json`. */
const APP_KIT_INSTALL_FIX = 'npm install';

export type { PinnedPackage };

/**
 * The packages `aw generate app` adds to `package.json`: the SDK's {@link sdkAppKitPackages}, the
 * same pins `create --template` writes, with the app kit in lock-step with `aw`
 * (`app-kit.test.ts` holds them equal to the repository's).
 */
export function appKitPackages(version: string = AW_VERSION): readonly PinnedPackage[] {
  return sdkAppKitPackages(version);
}

/**
 * The two fields `aw` reads from the app kit's `package.json`, which has many other keys, so the
 * object is deliberately not strict. The bin is one relative path inside the package.
 */
const AppKitManifestSchema = z.object({
  name: z.literal(APP_KIT_PACKAGE),
  // Printed in the skew message, so only the characters a semver may hold.
  version: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[0-9A-Za-z.+-]+$/u),
  bin: z.object({ [APP_KIT_BIN]: z.string().min(3).max(1024).regex(/^\.\//u) }),
});

/** Where the project's app kit is, once its version is known to match `aw`'s. */
export interface ResolvedAppKit {
  /** The real path of the `aw-app` bin inside the installed package. */
  readonly binPath: string;
  readonly version: string;
}

function notInstalled(detail: string): CommandRefusedError {
  return new CommandRefusedError(`app_kit_not_installed: ${detail}`, APP_KIT_INSTALL_FIX);
}

/** The real path of `relative` inside `root`, or `undefined` when it is no file there. */
async function fileInside(root: string, relative: string): Promise<string | undefined> {
  let target: string;
  try {
    target = await realpath(path.resolve(root, relative));
    if (!(await stat(target)).isFile()) return undefined;
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return undefined;
    throw error;
  }
  const inside = path.relative(root, target);
  return inside === '' || inside.startsWith('..') || path.isAbsolute(inside) ? undefined : target;
}

/**
 * Finds `@indx-workspace/app` the way the project's own code would (an ES module `import` from
 * `cwd`) and checks that its version is `aw`'s. A missing package, one without an `aw-app` bin
 * inside it, or a skewed one is refused as `app_kit_not_installed` with the install line.
 */
export async function resolveAppKit(cwd: string): Promise<ResolvedAppKit> {
  const packageDirectory = await findPackageDirectory(cwd, APP_KIT_PACKAGE);
  if (packageDirectory === undefined) {
    throw notInstalled(`${APP_KIT_PACKAGE} is not installed in this project`);
  }
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
  } catch {
    throw notInstalled(`${APP_KIT_PACKAGE} in node_modules has no readable package.json`);
  }
  const manifest = AppKitManifestSchema.safeParse(json);
  if (!manifest.success) {
    throw notInstalled(`${APP_KIT_PACKAGE} in node_modules has no ${APP_KIT_BIN} bin`);
  }
  const { version, bin } = manifest.data;
  if (version !== AW_VERSION) {
    throw notInstalled(
      `${APP_KIT_PACKAGE} ${version} is installed, but aw ${AW_VERSION} needs ${APP_KIT_PACKAGE} ${AW_VERSION}`,
    );
  }
  const binPath = await fileInside(await realpath(packageDirectory), bin[APP_KIT_BIN]);
  if (binPath === undefined) {
    throw notInstalled(`${APP_KIT_PACKAGE}'s ${APP_KIT_BIN} bin is missing from its package`);
  }
  return { binPath, version };
}

/**
 * The variables the bin gets from `aw`'s environment: what Node needs to start and find a
 * temporary directory, and nothing else. A key `aw` holds (`AGENT_WORKSPACE_API_KEY`, a model
 * key) never reaches it, and neither does `NODE_OPTIONS`, which could preload a module into it.
 */
const ALLOWED_ENV: readonly string[] = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'SYSTEMROOT',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
];

/** `env` reduced to {@link ALLOWED_ENV}, compared by upper case as Windows names them. */
export function appKitEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && ALLOWED_ENV.includes(name.toUpperCase())) result[name] = value;
  }
  return result;
}

/** What one `aw-app` run printed and how it ended. */
export interface AppKitRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** How long one `aw-app` run may take, and how much output `aw` keeps from it. */
const RUN_TIMEOUT_MS = 30_000;
const OUTPUT_MAX = 4 * 1024 * 1024;

/** Options of {@link runAppKit}: where it runs and what it inherits. */
export interface RunAppKitOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Variables the bin needs beyond {@link appKitEnvironment}, set by `aw` itself and never taken
   * from its environment: `DATABASE_URL` for `aw-app migrate` (issue #1506).
   */
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

/**
 * Runs the bin as `node <bin> <args>` (`process.execPath`, so the Node that runs `aw`), with
 * {@link appKitEnvironment} and the caller's `extraEnv`; killed on `signal` or after 30 seconds.
 */
export function runAppKit(
  binPath: string,
  args: readonly string[],
  options: RunAppKitOptions,
): Promise<AppKitRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd: options.cwd,
      env: { ...appKitEnvironment(options.env), ...options.extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: options.signal,
      timeout: RUN_TIMEOUT_MS,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < OUTPUT_MAX) stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < OUTPUT_MAX) stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/** One resource as `aw-app sql` reads it: what `aw generate resource` parsed. */
export interface ResourceSqlSpec {
  readonly name: string;
  readonly fields: readonly FieldSpec[];
  readonly board?: string;
}

/**
 * The migration SQL of one resource, from the project's `aw-app sql`. A refusal from the bin is
 * refused here with its own reason.
 */
export async function resourceTableSql(
  appName: string,
  spec: ResourceSqlSpec,
  options: RunAppKitOptions,
): Promise<string> {
  const { binPath } = await resolveAppKit(options.cwd);
  const run = await runAppKit(binPath, ['sql', '--app', appName, JSON.stringify(spec)], options);
  if (run.code !== 0 || run.stdout === '') {
    const reason = run.stderr.trim().replace(/^error: /u, '') || `exit code ${String(run.code)}`;
    throw new CommandRefusedError(`${APP_KIT_BIN} sql could not write the migration: ${reason}`);
  }
  return run.stdout;
}

/**
 * Whether `schedule(cron, timezone)` can start a recipe, as the project's `aw-app recipe-on` says
 * (issue #1514): croner and the time zone are the app kit's to check, and `aw` imports neither.
 *
 * @throws {UsageError} with the bin's reasons when it refuses the schedule (exit 1).
 * @throws {CommandRefusedError} when the bin cannot be run or fails in any other way.
 */
export async function checkRecipeSchedule(
  cron: string,
  timezone: string,
  options: RunAppKitOptions,
): Promise<void> {
  const { binPath } = await resolveAppKit(options.cwd);
  const run = await runAppKit(binPath, ['recipe-on', cron, '--tz', timezone], options);
  if (run.code === 0) return;
  const reason = run.stderr.trim().replace(/^error: /u, '') || `exit code ${String(run.code)}`;
  if (run.code === 1) throw new UsageError(`--on ${reason}`);
  throw new CommandRefusedError(`${APP_KIT_BIN} recipe-on could not check the schedule: ${reason}`);
}
