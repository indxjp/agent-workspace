import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

/**
 * The parent variables a smoke consumer inherits, compared case-insensitively (Windows spells
 * `Path`): where programs, the home and temporary directories are, the locale, and how to reach
 * the registry. Everything else stays behind, so a CI credential (the OIDC request token, a cache
 * or S3 secret) never reaches `npm install`, `npm rebuild` of a third-party install script, or the
 * runtime with its registry-resolved transitive dependencies. The embedded launcher sets every
 * variable the runtime reads itself.
 */
const INHERITED_VARIABLES = new Set([
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'LANG',
  'LANGUAGE',
  'TZ',
  'CI',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
]);

/**
 * The environment every smoke command runs with: only the parent variables
 * {@link INHERITED_VARIABLES} names, and the `LC_*` locale variables.
 * @param {NodeJS.ProcessEnv} parent
 * @returns {Record<string, string>}
 */
export function consumerEnvironment(parent) {
  /** @type {Record<string, string>} */
  const environment = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (INHERITED_VARIABLES.has(upper) || upper.startsWith('LC_')) environment[key] = value;
  }
  return environment;
}

/**
 * The environment the boot smoke forks the embedded runtime with: {@link consumerEnvironment},
 * plus the gateway and runner ports.
 * @param {NodeJS.ProcessEnv} parent
 * @param {{ gateway: number, runner: number }} ports
 * @returns {Record<string, string>}
 */
export function runtimeEnvironment(parent, ports) {
  return {
    ...consumerEnvironment(parent),
    GATEWAY_PORT: String(ports.gateway),
    RUNNER_PORT: String(ports.runner),
  };
}

/** What `cmd.exe` passes through unquoted: no space and no character it or the CRT interprets. */
const PLAIN_ARGUMENT = /^[A-Za-z0-9_@+=:,./\\-]+$/u;

/**
 * One `cmd.exe` command line for a `.cmd` shim such as `npm` or `pnpm`, each argument quoted when
 * it needs it (a path with a space). A quoted argument keeps its backslashes, doubled at its end so
 * the closing quote is not escaped. An argument holding a double quote, `%`, `!` or a line break is
 * refused, because `cmd.exe` expands or ends on those even inside quotes.
 * @param {string} command @param {readonly string[]} args
 * @returns {string}
 */
export function windowsCommandLine(command, args) {
  return [command, ...args]
    .map((argument) => {
      if (PLAIN_ARGUMENT.test(argument)) return argument;
      if (argument === '' || /["%!\r\n]/u.test(argument)) {
        throw new Error(`cannot pass ${JSON.stringify(argument)} through cmd.exe`);
      }
      return `"${argument.replace(/(\\+)$/u, '$1$1')}"`;
    })
    .join(' ');
}

/**
 * @param {string} command @param {readonly string[]} args @param {string} cwd
 * @param {{ env?: NodeJS.ProcessEnv, input?: string }} [options]
 */
export function run(command, args, cwd, options = {}) {
  // On Windows `npm`, `npx` and a `pnpm` found on PATH are `.cmd` shims only a shell runs.
  const viaShell = process.platform === 'win32' && !path.isAbsolute(command);
  const spawnOptions = { cwd, encoding: /** @type {const} */ ('utf8'), ...options };
  const result = viaShell
    ? spawnSync(windowsCommandLine(command, args), { ...spawnOptions, shell: true })
    : spawnSync(command, args, spawnOptions);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed in ${cwd}\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return result.stdout;
}

/**
 * {@link run} in a smoke consumer, with {@link consumerEnvironment} unless `options.env` is given
 * (built from it too): what runs there is registry-resolved third-party code.
 * @param {string} command @param {readonly string[]} args @param {string} cwd
 * @param {{ env?: NodeJS.ProcessEnv, input?: string }} [options]
 */
export function runInConsumer(command, args, cwd, options = {}) {
  return run(command, args, cwd, { env: consumerEnvironment(process.env), ...options });
}

/** `pnpm`, the one that runs this script when it is a package script, else the one on PATH. */
export function pnpmCommand() {
  const execPath = process.env['npm_execpath'];
  if (execPath === undefined || !/pnpm/u.test(execPath)) return { command: 'pnpm', prefix: [] };
  // pnpm is either a JavaScript entry point node runs, or `@pnpm/exe`'s native binary.
  return /\.[cm]?js$/u.test(execPath)
    ? { command: process.execPath, prefix: [execPath] }
    : { command: execPath, prefix: [] };
}
