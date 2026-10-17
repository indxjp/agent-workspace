/**
 * `npx`, served by `pnpm dlx` (ADR-0087 D1). The runner and runtime images carry no npm, but a
 * `stdio` connector's documented `command` is `npx` (spec §8, `docs/sdk/site/resources/connectors.mdx`),
 * so the images put this shim on `PATH` as `npx`. It maps the npx forms connectors use onto
 * `pnpm dlx`, and refuses everything else loudly rather than guessing:
 *
 *     npx [-y|--yes] <pkg>[@version] [args…]
 *       →  pnpm dlx --package <pkg>[@version] node npx-run-bin.mjs --package <pkg>[@version] -- [args…]
 *     npx [-y] -p <pkg> [-p <pkg>…] [--] <cmd> [args…]
 *       →  pnpm dlx --package <pkg>… node npx-run-bin.mjs --command <cmd> -- [args…]
 *
 * pnpm dlx installs and caches the packages; `npx-run-bin.mjs` then hands pnpm's bin script to
 * `/bin/sh` rather than executing it, because the dlx cache sits on `/tmp`, which the Docker
 * driver mounts `noexec` (see that file).
 *
 * A package given as a relative directory (`./dir`, `../dir`, `file:dir`) is resolved against the
 * working directory first: `pnpm dlx` installs from its own cache directory, where a relative path
 * names nothing. Every other spec (`name@version`, `alias@npm:name`, `github:org/repo`, a tarball
 * URL, an absolute directory) is passed to pnpm as it is.
 *
 * `-y`/`--yes` is dropped: `pnpm dlx` never prompts. Everything after the command is passed to the
 * command untouched, as npx does.
 *
 * The shim must work in the environment a connector is really launched with, not the image's:
 * every engine replaces the child environment (the runner's base environment is empty), and the
 * Docker driver, Kubernetes and the generated Compose runner use a read-only root filesystem where
 * only `/tmp` and `/workspace` are writable. So nothing here depends on the environment:
 *
 * - pnpm is `PNPM_CLI` when set, else the image's fixed `/opt/pnpm/bin/pnpm.cjs`, run with this
 *   Node;
 * - pnpm's child gets a `PATH` when it has none (a package's bin needs `node` on it), and pnpm's
 *   cache, store, state and config directories go under `/tmp/pnpm` for each `XDG_*` variable the
 *   caller did not set, so a read-only home directory is never written.
 *
 * No setting is needed against a `packageManager` pin in the working directory: `dlx` is one of
 * the commands pnpm runs without its package-manager check or version switch (ADR-0087 D1).
 */
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runInherited } from './npx-run-bin.mjs';

/** Where the images install pnpm (`Dockerfile`, `runtime.Dockerfile`). */
export const DEFAULT_PNPM_CLI = '/opt/pnpm/bin/pnpm.cjs';
/** Debian's default search path, for a child launched with no `PATH` at all. */
export const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
/** The root pnpm's directories default to: `/tmp` stays writable under `--read-only`. */
export const PNPM_TMP_ROOT = '/tmp/pnpm';

/** The bin runner that sits next to this file (`/opt/npx` in the images). */
export const RUN_BIN = fileURLToPath(new URL('./npx-run-bin.mjs', import.meta.url));

/** Thrown for an npx invocation this shim does not translate. */
export class UnsupportedNpxUsage extends Error {}

/**
 * A package spec as `pnpm dlx` must see it: a relative directory made absolute against `cwd`
 * (POSIX paths: the shim runs in the Linux images), anything else unchanged.
 *
 * @param {string} spec
 * @param {string} cwd the working directory npx was started in
 * @returns {string}
 */
export function dlxPackageSpec(spec, cwd) {
  const file = spec.startsWith('file:');
  const location = file ? spec.slice('file:'.length) : spec;
  // After `file:` every location that is not absolute is a path (`file:dir` included); without
  // it, only the forms npm reads as a directory are.
  const relative = file
    ? !path.posix.isAbsolute(location)
    : location === '.' ||
      location === '..' ||
      location.startsWith('./') ||
      location.startsWith('../');
  if (!relative) return spec;
  const absolute = path.posix.resolve(cwd, location);
  return file ? `file:${absolute}` : absolute;
}

/**
 * The `pnpm` arguments that run what `npx <argv>` would run.
 *
 * @param {readonly string[]} argv the arguments after `npx`
 * @param {{ node: string, runBin: string }} [runner] the Node and bin runner the command runs with
 * @param {string} [cwd] the working directory relative directory specs are resolved against
 * @returns {string[]}
 */
export function npxToPnpmDlx(
  argv,
  runner = { node: process.execPath, runBin: RUN_BIN },
  cwd = process.cwd(),
) {
  /** @type {string[]} */
  const packages = [];
  let index = 0;
  while (index < argv.length) {
    const argument = /** @type {string} */ (argv[index]);
    if (argument === '--') {
      index += 1;
      break;
    }
    if (!argument.startsWith('-')) break;
    if (argument === '-y' || argument === '--yes') {
      index += 1;
    } else if (argument === '-p' || argument === '--package') {
      const value = argv[index + 1];
      if (value === undefined || value === '' || value.startsWith('-')) {
        throw new UnsupportedNpxUsage(`npx: ${argument} needs a package name`);
      }
      packages.push(dlxPackageSpec(value, cwd));
      index += 2;
    } else if (argument.startsWith('--package=')) {
      const value = argument.slice('--package='.length);
      if (value === '' || value.startsWith('-')) {
        throw new UnsupportedNpxUsage('npx: --package= needs a package name');
      }
      packages.push(dlxPackageSpec(value, cwd));
      index += 1;
    } else {
      throw new UnsupportedNpxUsage(
        `npx: ${argument} is not supported in this image. npx here is served by \`pnpm dlx\`, which takes only -y/--yes, -p/--package and -- (ADR-0087)`,
      );
    }
  }
  const command = argv[index];
  if (command === undefined || command === '') {
    throw new UnsupportedNpxUsage('npx: name a package or command to run');
  }
  if (command.startsWith('-')) {
    // `pnpm dlx` would read it as one of its own options.
    throw new UnsupportedNpxUsage(`npx: a package or command named ${command} is not supported`);
  }
  const spec = dlxPackageSpec(command, cwd);
  const target = packages.length === 0 ? ['--package', spec] : ['--command', command];
  return [
    'dlx',
    ...(packages.length === 0 ? [spec] : packages).flatMap((name) => ['--package', name]),
    runner.node,
    runner.runBin,
    ...target,
    '--',
    ...argv.slice(index + 1),
  ];
}

/**
 * The pnpm process that serves `npx <argv>`: its entry point, arguments and environment.
 *
 * @param {readonly string[]} argv the arguments after `npx`
 * @param {Readonly<Record<string, string | undefined>>} environment the shim's own environment
 * @returns {{ cli: string, args: string[], env: Record<string, string> }}
 */
export function pnpmInvocation(argv, environment) {
  const args = npxToPnpmDlx(argv);
  /** @type {Record<string, string>} */
  const env = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined) env[name] = value;
  }
  if (!env.PATH) env.PATH = DEFAULT_PATH;
  for (const [name, directory] of /** @type {const} */ ([
    ['XDG_CACHE_HOME', 'cache'],
    ['XDG_DATA_HOME', 'data'],
    ['XDG_STATE_HOME', 'state'],
    ['XDG_CONFIG_HOME', 'config'],
  ])) {
    if (!env[name]) env[name] = `${PNPM_TMP_ROOT}/${directory}`;
  }
  return { cli: environment.PNPM_CLI || DEFAULT_PNPM_CLI, args, env };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  /** @type {ReturnType<typeof pnpmInvocation>} */
  let invocation;
  try {
    invocation = pnpmInvocation(process.argv.slice(2), process.env);
  } catch (error) {
    if (!(error instanceof UnsupportedNpxUsage)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  runInherited(process.execPath, [invocation.cli, ...invocation.args], invocation.env);
}
