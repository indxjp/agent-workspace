import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { CommandRefusedError } from '../io.js';
import { AW_VERSION } from '../version.js';
import { errorCode } from './project.js';

/** The package that holds the local runtime; `aw dev` resolves it from the project, never imports it. */
export const EMBEDDED_PACKAGE = '@indx-workspace/embedded';

/**
 * The one line that installs the runtime this `aw` speaks to: released in lock-step, so the same
 * version as `aw` itself.
 */
export const EMBEDDED_INSTALL_FIX = `npm install -D ${EMBEDDED_PACKAGE}@${AW_VERSION}`;

/**
 * The two fields `aw dev` reads from the runtime's `package.json`. It is a foreign file with many
 * other keys, so the object is deliberately not strict: unknown keys are dropped, not refused.
 */
const EmbeddedManifestSchema = z.object({
  name: z.literal(EMBEDDED_PACKAGE),
  // A version is printed in the skew message, so only the characters a semver may hold.
  version: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[0-9A-Za-z.+-]+$/u),
});

/**
 * The runtime's `./launch` export, read from its `exports` map. The runtime released with this `aw`
 * declares it as one relative path (`"./launch": "./dist/bin.js"`), so that is the only shape
 * accepted: a conditional target, or a path that does not start with `./`, is not this runtime.
 */
const LaunchExportSchema = z.object({
  exports: z.object({
    './launch': z.string().min(3).max(1024).regex(/^\.\//u),
  }),
});

/** Where the project's local runtime is, once its version is known to match `aw`'s. */
export interface ResolvedLocalRuntime {
  /** The absolute path of the runtime's `./launch` export, which `aw dev` forks. */
  readonly launchPath: string;
  readonly version: string;
}

function notInstalled(): CommandRefusedError {
  return new CommandRefusedError(
    `${EMBEDDED_PACKAGE} is not installed in this project`,
    EMBEDDED_INSTALL_FIX,
  );
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return false;
    throw error;
  }
}

/**
 * The directory of the package `name` as an ES module `import` from `cwd` finds it: the first
 * `node_modules/<name>` in `cwd` or one of its parents. Unlike CommonJS resolution, this never
 * consults `NODE_PATH` — the runtime is an ES module, and a package found only through
 * `NODE_PATH` (pnpm's bin shims set it to the store) is not one the project installed.
 */
export async function findPackageDirectory(cwd: string, name: string): Promise<string | undefined> {
  let directory = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(directory, 'node_modules', ...name.split('/'));
    if (await isDirectory(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return false;
    throw error;
  }
}

/**
 * The real path of the `./launch` export inside the package, read from its `exports` map with file
 * system calls only. A module resolver (`createRequire(...).resolve`) is deliberately not used: the
 * runtime is not a dependency of `aw`, so the §42 boundary gate (tests/no-sdk-import.test.ts) can
 * neither resolve that specifier nor decide one that is computed, and refuses either. A package
 * without the export, with a target that is missing, or with one that leaves the package (`..`, or
 * a symbolic link out of it) is not the runtime this project installed.
 */
async function launchExportPath(packageDirectory: string, manifest: unknown): Promise<string> {
  const parsed = LaunchExportSchema.safeParse(manifest);
  if (!parsed.success) throw notInstalled();
  const root = await realpath(packageDirectory);
  const candidate = path.resolve(root, parsed.data.exports['./launch']);
  if (!(await isFile(candidate))) throw notInstalled();
  const launchPath = await realpath(candidate);
  const relative = path.relative(root, launchPath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw notInstalled();
  }
  return launchPath;
}

/**
 * Find `@indx-workspace/embedded` the way the project's own code would (an ES module `import` from
 * `cwd`), and check that its version is `aw`'s. A missing package, one without the `./launch`
 * export, or a skewed one is refused with the install line.
 */
export async function resolveLocalRuntime(cwd: string): Promise<ResolvedLocalRuntime> {
  const packageDirectory = await findPackageDirectory(cwd, EMBEDDED_PACKAGE);
  if (packageDirectory === undefined) throw notInstalled();
  const manifestPath = path.join(packageDirectory, 'package.json');
  let json: unknown;
  try {
    json = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw notInstalled();
  }
  const launchPath = await launchExportPath(packageDirectory, json);
  const manifest = EmbeddedManifestSchema.safeParse(json);
  if (!manifest.success) throw notInstalled();
  const { version } = manifest.data;
  if (version !== AW_VERSION) {
    throw new CommandRefusedError(
      `${EMBEDDED_PACKAGE} ${version} is installed, but aw ${AW_VERSION} needs ${EMBEDDED_PACKAGE} ${AW_VERSION}`,
      EMBEDDED_INSTALL_FIX,
    );
  }
  return { launchPath, version };
}
