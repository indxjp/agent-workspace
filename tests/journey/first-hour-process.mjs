/* global process, setTimeout, clearTimeout */
import { spawn } from 'node:child_process';
import { parseDevLine } from './harness.mjs';

/** The user's shell: no harness npm cache, so T1/T2 start cold as B1's do (run.mjs). */
const USER_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== 'npm_config_cache'),
);

/**
 * One command as the page writes it, in a shell with no TTY on any stream.
 *
 * @param {string} command @param {string} cwd
 */
export function runShell(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd,
      env: USER_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let stdout = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        output += String(chunk);
        if (stream === child.stdout) stdout += String(chunk);
        process.stdout.write(String(chunk));
      });
    }
    child.once('close', (status) => resolve({ status, output, stdout }));
  });
}

/** @param {import('node:child_process').ChildProcess} child */
export function killGroup(child) {
  try {
    process.kill(-(child.pid ?? 0), 'SIGKILL');
  } catch {
    // already gone
  }
}

/**
 * `npm run dev`, detached from the step; resolves with its pid once it prints `try:`.
 *
 * @param {string} cwd @param {number} timeoutMs
 */
export function startDev(cwd, timeoutMs) {
  // Detached: its own process group, so the kill reaches `aw dev` under npm, not npm alone.
  const child = spawn('sh', ['-c', 'exec npm run dev'], {
    cwd,
    env: USER_ENV,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  return new Promise((resolve, reject) => {
    let pending = '';
    const timer = setTimeout(() => {
      killGroup(child);
      reject(new Error(`aw dev printed no try: line in ${String(timeoutMs)} ms\n${log}`));
    }, timeoutMs);
    child.once('close', (status) => {
      clearTimeout(timer);
      reject(new Error(`aw dev exited ${String(status)} before it was ready\n${log}`));
    });
    /** @param {unknown} chunk */
    const read = (chunk) => {
      log += String(chunk);
      process.stdout.write(String(chunk));
      pending += String(chunk);
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      if (lines.some((line) => parseDevLine(line)?.kind === 'try')) {
        clearTimeout(timer);
        resolve({ child, pid: child.pid, log: () => log });
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
  });
}
