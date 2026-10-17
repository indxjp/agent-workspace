/**
 * The second half of `npx` in the runner and runtime images (ADR-0087 D1). `pnpm dlx` has
 * installed the packages and put their `node_modules/.bin` first on `PATH`; this runs the command
 * from there.
 *
 * It exists because of where the images can write. Under the Docker driver the root filesystem is
 * read-only and `/tmp` is a tmpfs mounted `noexec`, so pnpm's dlx cache sits on a filesystem
 * nothing can be executed from, and `pnpm dlx` executing the bin fails with EACCES. pnpm's bin
 * entries are POSIX shell scripts that set `NODE_PATH` and `exec node <entry point>`, so this
 * hands the script to `/bin/sh` to read (reading needs no exec permission) instead of executing
 * it. Node and sh live on the image's own filesystem. A bin that is itself a native binary still
 * cannot run from a `noexec` cache (the shell reports that), and Node cannot load a native addon
 * (`.node`) from one.
 *
 *     node npx-run-bin.mjs --package <spec> -- [args…]   the bin of <spec>, chosen as npx chooses it
 *     node npx-run-bin.mjs --command <name> -- [args…]   a bin of the installed packages, else <name> on PATH
 *
 * A `--command` with a `/` is a path, never a bin: it runs relative to the working directory.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Thrown when the command to run cannot be determined, as npx would refuse it. */
export class NpxBinError extends Error {}

/**
 * The package `pnpm dlx --package <spec>` installed, as pnpm itself finds it: the first dependency
 * of the dlx project's `package.json` (pnpm's `getPkgName`). That key is the name the package was
 * installed under for every form of spec: `name@range`, an alias (`alias@npm:pkg` → `alias`), a
 * git host (`github:org/repo`), a directory (`./dir`) or a tarball URL.
 *
 * @param {{ dependencies?: unknown }} projectManifest the dlx project's package.json
 * @param {string} spec the spec npx was given, for the message
 * @returns {string}
 */
export function installedPackageName(projectManifest, spec) {
  const { dependencies } = projectManifest;
  const names =
    typeof dependencies === 'object' && dependencies !== null ? Object.keys(dependencies) : [];
  const name = names[0];
  if (name === undefined || name === '') {
    throw new NpxBinError(`npx: pnpm dlx recorded no installed dependency for ${spec}`);
  }
  return name;
}

/**
 * A path with its symbolic links resolved: the real path of its nearest existing ancestor, with
 * the part that does not exist yet appended. Resolving only paths that exist would compare a
 * resolved directory with an unresolved target (macOS: `/var` → `/private/var`).
 *
 * @param {string} location
 */
export function realPath(location) {
  let current = path.resolve(location);
  /** @type {string[]} */
  const missing = [];
  for (;;) {
    try {
      return path.join(realpathSync(current), ...missing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(location);
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * `target` lies inside `directory` once both are resolved through their symbolic links. pnpm
 * itself checks only the lexical path, so it still links a bin whose symbolic link leaves the
 * package; this check is what refuses to run one. A name inside that merely starts with `..`
 * (`..x/cli.js`) is inside.
 *
 * @param {string} directory
 * @param {string} target
 */
export function isInside(directory, target) {
  const relative = path.relative(realPath(directory), realPath(target));
  return !(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

/**
 * The files under a directory, relative to it, as pnpm's `findFiles` lists a package's
 * `directories.bin`: regular files at any depth, dot-entries skipped. A symbolic link inside the
 * directory, to a file or a directory, is not followed and lists nothing; the directory itself is
 * only listed when its real path stays inside the package (see `packageBinNames`).
 *
 * @param {string} directory
 * @returns {string[]}
 */
export function listBinDirectory(directory) {
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
    .filter((file) => !file.split(path.sep).some((part) => part.startsWith('.')));
}

/**
 * The bin names a package links, as pnpm's `getBinsFromPackageManifest` reads them: `bin` (a string
 * is named after the package), else every file under `directories.bin`. A scope is dropped from a
 * name, and names pnpm would not link (empty, `.`, `..`, not URL-safe) and paths outside the
 * package are left out. "Outside" is judged on real paths: a `directories.bin` (or a `bin` file)
 * that is a symbolic link leading out of the package is left out here, so the shim refuses to run
 * it, even though pnpm, which checks only the lexical path, still links it.
 *
 * @param {{ name?: unknown, bin?: unknown, directories?: unknown }} manifest the package's package.json
 * @param {string} name the package name, when the manifest has none
 * @param {string} packageDirectory where the package is installed
 * @param {(directory: string) => readonly string[]} [listFiles] lists a directory's files
 * @returns {string[]}
 */
export function packageBinNames(manifest, name, packageDirectory, listFiles = listBinDirectory) {
  const packageName =
    typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : name;
  const { bin, directories } = manifest;
  if (bin) {
    /** @type {[string, unknown][]} */
    const entries =
      typeof bin === 'string'
        ? [[packageName, bin]]
        : typeof bin === 'object'
          ? Object.entries(bin)
          : [];
    return entries
      .filter(
        ([, file]) =>
          typeof file === 'string' && isInside(packageDirectory, path.join(packageDirectory, file)),
      )
      .map(([key]) => (key.startsWith('@') ? key.slice(key.indexOf('/') + 1) : key))
      .filter(
        (binName) =>
          binName !== '' &&
          binName !== '.' &&
          binName !== '..' &&
          (binName === encodeURIComponent(binName) || binName === '$'),
      );
  }
  const binDirectory =
    typeof directories === 'object' && directories !== null && 'bin' in directories
      ? directories.bin
      : undefined;
  if (typeof binDirectory === 'string' && binDirectory !== '') {
    const directory = path.join(packageDirectory, binDirectory);
    if (!isInside(packageDirectory, directory)) return [];
    return listFiles(directory).map((file) => path.basename(file));
  }
  return [];
}

/**
 * The name of the bin npx runs for a package: its only bin, else the one named after the package
 * without its scope (pnpm's `getBinName`, which npm's npx also follows).
 *
 * @param {{ name?: unknown, bin?: unknown, directories?: unknown }} manifest the package's package.json
 * @param {string} name the name the package was installed under
 * @param {string} packageDirectory where the package is installed
 * @param {(directory: string) => readonly string[]} [listFiles] lists a directory's files
 * @returns {string}
 */
export function selectPackageBin(manifest, name, packageDirectory, listFiles = listBinDirectory) {
  const names = packageBinNames(manifest, name, packageDirectory, listFiles);
  if (names.length === 1) return /** @type {string} */ (names[0]);
  const packageName =
    typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : name;
  const unscoped = packageName.startsWith('@')
    ? packageName.slice(packageName.indexOf('/') + 1)
    : packageName;
  if (names.includes(unscoped)) return unscoped;
  throw new NpxBinError(`npx: could not determine the executable to run for ${name}`);
}

/**
 * Reads a JSON file, or `undefined` when it is absent or malformed.
 *
 * @param {string} file
 * @returns {Record<string, unknown> | undefined}
 */
function readJson(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return typeof value === 'object' && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What to run: pnpm's bin script for the command, or, for a command the installed packages do not
 * provide, the bare name to look up on PATH (`npx -p <pkg> <cmd>` allows any command).
 *
 * @param {{ nodeModules: string, package?: string, command?: string }} request
 * @returns {{ script: string } | { command: string }}
 */
export function resolveBin(request) {
  const binDirectory = path.join(request.nodeModules, '.bin');
  if (request.package !== undefined) {
    const project = readJson(path.join(path.dirname(request.nodeModules), 'package.json'));
    if (project === undefined) {
      throw new NpxBinError(`npx: pnpm dlx left no project manifest for ${request.package}`);
    }
    const name = installedPackageName(project, request.package);
    const packageDirectory = path.join(request.nodeModules, name);
    const manifest = readJson(path.join(packageDirectory, 'package.json'));
    if (manifest === undefined) {
      throw new NpxBinError(`npx: ${request.package} did not install a package named ${name}`);
    }
    const script = path.join(binDirectory, selectPackageBin(manifest, name, packageDirectory));
    if (!existsSync(script)) throw new NpxBinError(`npx: pnpm did not link ${script}`);
    return { script };
  }
  const command = /** @type {string} */ (request.command);
  // A path (`./run.sh`, `bin/x`) is not a bin name: npx runs it relative to the working directory,
  // as spawning it does, and it must never reach into `.bin` (`../.bin/x`, `a/../../x`).
  if (command.includes('/') || command.includes(path.sep)) return { command };
  if (command === '.' || command === '..') {
    throw new NpxBinError(`npx: ${command} is a directory, not a command to run`);
  }
  const script = path.join(binDirectory, command);
  return existsSync(script) ? { script } : { command };
}

/**
 * The `node_modules` pnpm dlx installed into: the directory above the first `.bin` on `PATH`.
 *
 * @param {string | undefined} searchPath
 */
export function dlxNodeModules(searchPath) {
  const first = (searchPath ?? '').split(path.delimiter)[0] ?? '';
  if (path.basename(first) !== '.bin' || path.basename(path.dirname(first)) !== 'node_modules') {
    throw new NpxBinError('npx: not started by pnpm dlx (no node_modules/.bin first on PATH)');
  }
  return path.dirname(first);
}

/**
 * The process that runs the resolved bin: its script read by `/bin/sh`, or the command itself.
 *
 * @param {{ script: string } | { command: string }} target
 * @param {readonly string[]} args
 * @param {string} [shell]
 * @returns {[string, string[]]}
 */
export function binProcess(target, args, shell = '/bin/sh') {
  return 'script' in target ? [shell, [target.script, ...args]] : [target.command, [...args]];
}

/**
 * Runs a child with stdio inherited (an MCP stdio server talks through these very pipes),
 * forwarding signals and ending with the child's exit status or signal.
 *
 * @param {string} command
 * @param {readonly string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 */
export function runInherited(command, args, env = process.env) {
  const child = spawn(command, [...args], { stdio: 'inherit', env });
  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('error', (error) => {
    process.stderr.write(`npx: could not start ${command}: ${error.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      // Die of the same signal, as npx would; the forwarding handler must not catch it.
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 1);
    }
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const [mode, value, separator, ...args] = process.argv.slice(2);
  try {
    if ((mode !== '--package' && mode !== '--command') || !value || separator !== '--') {
      throw new NpxBinError('usage: npx-run-bin.mjs --package <spec>|--command <name> -- [args…]');
    }
    const nodeModules = dlxNodeModules(process.env.PATH);
    const target = resolveBin(
      mode === '--package' ? { nodeModules, package: value } : { nodeModules, command: value },
    );
    runInherited(...binProcess(target, args));
  } catch (error) {
    if (!(error instanceof NpxBinError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
}
