/* global setTimeout, clearTimeout */
import { spawn } from 'node:child_process';
import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import process from 'node:process';

/**
 * Removes the work directory. A run this E2E starts writes its skills `0o444` under `0o555`
 * directories, as `packages/engine/src/skills.ts` intends, and an entry of a directory without its
 * write bit cannot be removed. So every directory in the tree (never through a symlink) gets its
 * owner's `rwx` back before the tree is removed; the files need nothing, as removing one asks only
 * for its directory's write bit.
 *
 * @param {string} directory
 */
export function removeWorkDirectory(directory) {
  /** @param {string} at */
  const writable = (at) => {
    const stats = lstatSync(at, { throwIfNoEntry: false });
    if (stats === undefined || !stats.isDirectory()) return;
    if ((stats.mode & 0o700) !== 0o700) chmodSync(at, (stats.mode & 0o7777) | 0o700);
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isDirectory()) writable(path.join(at, entry.name));
    }
  };
  writable(directory);
  rmSync(directory, { recursive: true, force: true });
}

/** The cases `--case` names: the portal, the presets (by their directories), then `desk`. */
const CASES = ['portal', 'team-chat', 'wiki', 'crm', 'service-desk', 'desk'];

/**
 * The cases to run: every one, or the one `--case <name>` names.
 *
 * @param {readonly string[]} argv
 */
export function casesOf(argv) {
  const at = argv.indexOf('--case');
  if (at === -1) return CASES;
  const named = argv[at + 1];
  if (named === undefined || !CASES.includes(named)) {
    throw new Error(`--case takes one of ${CASES.join(', ')}`);
  }
  return [named];
}

/** How long `aw dev` may take to say it is ready, and to stop. */
const READY_TIMEOUT_MS = 10 * 60_000;

const STOP_TIMEOUT_MS = 60_000;

/** @param {number} port */
function isFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/**
 * The first free port from `base`, skipping `taken`. The apps lane picks its ports so too.
 *
 * @param {number} base @param {Set<number>} taken
 */
export async function freePort(base, taken) {
  for (let port = base; port < base + 200; port += 1) {
    if (!taken.has(port) && (await isFree(port))) {
      taken.add(port);
      return port;
    }
  }
  throw new Error(`no free port from ${String(base)}`);
}

/**
 * `aw dev` in `cwd`, collecting its output, resolved once `until` holds or rejected when it exits
 * first. `stop()` interrupts it and waits for it to exit. The apps lane starts its apps so too.
 *
 * @param {string} aw @param {string} cwd @param {NodeJS.ProcessEnv} env @param {readonly string[]} args
 */
export function startDev(aw, cwd, env, args) {
  const child = spawn(process.execPath, [aw, 'dev', '--no-open', ...args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => (output.stdout += String(chunk)));
  child.stderr.on('data', (chunk) => (output.stderr += String(chunk)));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return {
    output,
    /** @param {(output: { stdout: string, stderr: string }) => boolean} until */
    async waitFor(until) {
      const deadline = Date.now() + READY_TIMEOUT_MS;
      let done = false;
      void exited.then(() => (done = true));
      while (!until(output)) {
        if (done)
          throw new Error(`aw dev exited before it was ready:\n${output.stdout}${output.stderr}`);
        if (Date.now() > deadline) {
          throw new Error(`aw dev was not ready in time:\n${output.stdout}${output.stderr}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
      const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
      await exited;
      clearTimeout(timer);
    },
  };
}

/** @param {{ stdout: string }} output */
export const readyWithApp = ({ stdout }) =>
  /^ {2}app {7}http:\/\/127\.0\.0\.1:\d+$/mu.test(stdout) && /^synced: .*"triage"/mu.test(stdout);

/** @param {{ stdout: string }} output */
export const readyWithAnyApp = ({ stdout }) =>
  /^ {2}app {7}http:\/\/127\.0\.0\.1:\d+$/mu.test(stdout) && /^synced: /mu.test(stdout);

/** @param {{env: NodeJS.ProcessEnv, scripts: string, bases: {web: number, gateway: number, runner: number, database: number}}} options */
export async function reserveDevRuntime({ env, scripts, bases }) {
  const taken = new Set();
  const ports = {
    web: await freePort(bases.web, taken),
    gateway: await freePort(bases.gateway, taken),
    runner: await freePort(bases.runner, taken),
    database: await freePort(bases.database, taken),
  };
  return {
    ports,
    origin: `http://127.0.0.1:${String(ports.web)}`,
    devArgs: ['--port', String(ports.web)],
    devEnv: {
      ...env,
      AW_SCRIPTED_MODELS_DIR: scripts,
      GATEWAY_PORT: String(ports.gateway),
      RUNNER_PORT: String(ports.runner),
      AW_DATABASE_PORT: String(ports.database),
    },
  };
}
