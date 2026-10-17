/* global setTimeout, clearTimeout */
/**
 * The machine the claims run on when there is no container: the runner's own macOS or Windows (or
 * Linux) host, as a user's machine is (issue #881). Commands run in the shell the docs name, in a
 * home directory of the run's own, with npm's cache and global prefix inside it, so the run leaves
 * nothing behind and finds nothing a user would not have. Same interface as the container machine
 * in `run.mjs`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { watchDev } from '../journey/run.mjs';

const WINDOWS = process.platform === 'win32';

/** The shells `--shell` names, and which of the docs' command syntaxes each one speaks. */
const SHELLS = {
  sh: { exe: 'sh', args: ['-c'], family: 'posix' },
  bash: { exe: 'bash', args: ['-c'], family: 'posix' },
  pwsh: {
    exe: 'pwsh',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
    family: 'powershell',
  },
};

export const SHELL_NAMES = Object.keys(SHELLS);

/**
 * Stop a process and everything it started: its group on POSIX (it leads one, see `launch`), its
 * tree on Windows.
 *
 * @param {import('node:child_process').ChildProcess} child
 */
function killTree(child) {
  if (child.pid === undefined) return;
  if (WINDOWS) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

/**
 * @param {{ shell: keyof typeof SHELLS, work: string, registry: string,
 *   env: Readonly<Record<string, string>>, commandMs: number, logs: string }} options
 */
export function createHostMachine(options) {
  const { exe, args, family } = SHELLS[options.shell];
  const home = path.join(options.work, 'home');
  const prefix = path.join(home, '.npm-global');
  const bin = WINDOWS ? prefix : path.join(prefix, 'bin');
  mkdirSync(home, { recursive: true });
  const pathKey = Object.keys(process.env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
  const base = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    [pathKey]: [bin, process.env[pathKey]].join(path.delimiter),
    NPM_CONFIG_PREFIX: prefix,
    npm_config_cache: path.join(home, '.npm'),
    npm_config_registry: options.registry,
    ...options.env,
  };

  /**
   * @param {string} command @param {string} cwd @param {Readonly<Record<string, string>>} [env]
   */
  const launch = (command, cwd, env = {}) =>
    spawn(exe, [...args, command], {
      cwd,
      env: { ...base, ...env },
      // A group of its own on POSIX, so a timeout or Ctrl+C reaches what the command started.
      detached: !WINDOWS,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

  return {
    kind: 'host',
    shell: family,
    // A fifo held open by the shell is a POSIX thing; Git Bash on Windows has none to speak of.
    fifo: family === 'posix' && !WINDOWS,
    env: options.env,
    commandMs: options.commandMs,
    logs: options.logs,
    claims: path.join(home, 'claims'),
    compile: path.join(home, 'compile'),
    resolve: (/** @type {string} */ cwd, /** @type {string} */ to) => path.resolve(cwd, to),
    mkdir: (/** @type {string} */ dir) => {
      mkdirSync(dir, { recursive: true });
      return Promise.resolve();
    },
    // A folder of a user's own: npm installs into the closest ancestor with a `package.json` or a
    // `node_modules`, and on a shared machine that may be one of somebody else's (a stray
    // /tmp/node_modules), where the container's home has none.
    project: (/** @type {string} */ dir) => {
      mkdirSync(dir, { recursive: true });
      if (!existsSync(path.join(dir, 'package.json'))) {
        writeFileSync(path.join(dir, 'package.json'), '{"private":true}\n');
      }
      return Promise.resolve();
    },
    // Retries cover Windows holding a file briefly after the process that used it was killed.
    remove: (/** @type {string} */ dir) => {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      return Promise.resolve();
    },
    list: (/** @type {string} */ dir) => Promise.resolve(readdirSync(dir)),
    stageCompile: (/** @type {string} */ stage) => Promise.resolve(stage),
    /**
     * @param {string} command one command of a block, in the machine's shell
     * @param {{ cwd: string, env?: Readonly<Record<string, string>>, timeoutMs: number }} run
     * @returns {Promise<{ status: number | null, output: string, stdout: string }>}
     */
    exec(command, run) {
      return new Promise((resolve, reject) => {
        const child = launch(command, run.cwd, run.env);
        let output = '';
        let stdout = '';
        child.stdout.on('data', (chunk) => {
          output += chunk.toString('utf8');
          stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk) => {
          output += chunk.toString('utf8');
        });
        const timer = setTimeout(() => killTree(child), run.timeoutMs);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', (status) => {
          clearTimeout(timer);
          resolve({ status, output, stdout });
        });
      });
    },
    /** @param {string} cwd @param {Readonly<Record<string, string>>} [env] */
    startDev(cwd, env) {
      const child = launch(family === 'posix' ? 'exec npm run dev' : 'npm run dev', cwd, env);
      return watchDev(child, {
        // Ctrl+C as a terminal sends it, to the group `npm run dev` leads. Windows has no signal
        // for a process tree, so there it is killed, and the exit code says nothing.
        interrupt: async () => {
          if (WINDOWS) killTree(child);
          else if (child.pid !== undefined) process.kill(-child.pid, 'SIGINT');
        },
        survivors: async () => `process ${String(child.pid)} and its group are still running`,
        cleanExits: family === 'posix' && !WINDOWS ? [0, 130] : null,
      });
    },
  };
}
