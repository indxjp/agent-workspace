/* global setTimeout, clearTimeout, console */
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

/**
 * Run `command` and return its status and output, never throwing.
 *
 * @param {string} command @param {readonly string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} [options]
 */
export function attempt(command, args, options = {}) {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 900_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { status: result.status ?? -1, stdout: result.stdout ?? '', output };
}

/**
 * {@link attempt} without blocking this process: for a command that needs the lane to keep
 * serving while it runs. The journeys do: the scripted model (`startFakeModel`) answers from this
 * process, and `aw dev`'s output pipes are drained here, so a `spawnSync` would leave every model
 * request of an agent run unanswered (and the run live) until Playwright had given up.
 *
 * @param {string} command @param {readonly string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} [options]
 * @returns {Promise<{ status: number, stdout: string, output: string }>}
 */
export function attemptAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 900_000);
    const done = (/** @type {number} */ status) => {
      clearTimeout(timer);
      resolve({ status, stdout, output: `${stdout}${stderr}` });
    };
    child.once('error', (error) => {
      stderr += String(error);
      done(-1);
    });
    child.once('close', (code) => done(code ?? -1));
  });
}

/** The last lines of `text`, for a reason. @param {string} text */
export const tail = (text) => text.trim().split('\n').slice(-12).join('\n');

/**
 * `command` as a step: `ok` when it exits 0, else `failed` with its last lines.
 *
 * @param {string} label @param {string} command @param {readonly string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} options
 */
export function stepOf(label, command, args, options) {
  console.log(`   $ ${label}`);
  const result = attempt(command, args, options);
  return result.status === 0
    ? { status: 'ok', reason: label }
    : {
        status: 'failed',
        reason: `${label} exited ${String(result.status)}:\n${tail(result.output)}`,
      };
}
