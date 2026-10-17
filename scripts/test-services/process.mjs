/* global AbortController, fetch */
import { randomInt } from 'node:crypto';
import { createServer } from 'node:net';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { TestServicesError } from './errors.mjs';

/**
 * @param {string} label
 * @param {() => boolean | Promise<boolean>} probe
 * @param {number} [timeoutMs]
 */
export async function waitUntil(label, probe, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await delay(500);
  }
  throw new TestServicesError(
    'test_service_not_ready',
    `${label} did not become ready within ${String(timeoutMs)} milliseconds.`,
  );
}

/**
 * The readiness probe both S3 paths share (ADR-0066): `GET /healthz` on the S3 port answers 200.
 *
 * @param {string} endpoint
 * @param {() => void} [assertRunning] throws when the server has already exited
 */
export async function waitForS3Health(endpoint, assertRunning = () => undefined) {
  await waitUntil('The S3 test server', async () => {
    assertRunning();
    try {
      return (await fetch(`${endpoint}/healthz`)).ok;
    } catch {
      return false;
    }
  });
}

/**
 * Bind `port` (0: any) on 127.0.0.1, release it, and answer the port that was bound, or `null`
 * when it is taken.
 *
 * @param {number} [port]
 * @returns {Promise<number | null>}
 */
export function tryPort(port = 0) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(null));
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const bound = typeof address === 'object' && address !== null ? address.port : null;
      server.close(() => resolve(bound));
    });
  });
}

/** @returns {Promise<number>} */
export async function freePort() {
  const port = await tryPort(0);
  if (port === null) {
    throw new TestServicesError('test_service_no_port', 'No free 127.0.0.1 port was available.');
  }
  return port;
}

/**
 * `count` distinct free ports `p` whose gRPC companion `p + 10000` is free too. SeaweedFS derives
 * every component's gRPC port that way, and its worker ignores an explicit override, so the pair
 * must be free together. Candidates come from 10000–29999, below Linux's ephemeral range.
 *
 * @param {number} count
 * @returns {Promise<number[]>}
 */
export async function freePortsWithGrpc(count) {
  /** @type {Set<number>} */
  const taken = new Set();
  /** @type {number[]} */
  const ports = [];
  for (let attempt = 0; ports.length < count && attempt < 200; attempt += 1) {
    const port = randomInt(10_000, 30_000);
    if (taken.has(port) || taken.has(port + 10_000)) continue;
    if ((await tryPort(port)) === null || (await tryPort(port + 10_000)) === null) continue;
    taken.add(port).add(port + 10_000);
    ports.push(port);
  }
  if (ports.length < count) {
    throw new TestServicesError(
      'test_service_no_port',
      `Could not find ${String(count)} free 127.0.0.1 port pairs for SeaweedFS.`,
    );
  }
  return ports;
}

/**
 * Keep the last few kilobytes a child wrote, to explain a start that failed.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @returns {() => string}
 */
export function captureOutput(child) {
  let output = '';
  /** @param {Buffer} chunk */
  const keep = (chunk) => {
    output = (output + chunk.toString('utf8')).slice(-8_000);
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  return () => output.trim();
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @returns {boolean}
 */
export function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Resolve once `child` has exited: ask it to stop with `request` (SIGTERM by default), and SIGKILL
 * it after `timeoutMs`.
 *
 * @param {import('node:child_process').ChildProcess | undefined} child
 * @param {{ request?: (child: import('node:child_process').ChildProcess) => void; timeoutMs?: number }} [options]
 */
export async function stopProcess(child, options = {}) {
  if (child === undefined || child.pid === undefined || hasExited(child)) return;
  const { request = (running) => running.kill('SIGTERM'), timeoutMs = 10_000 } = options;
  const exited = new Promise((resolve) => child.once('exit', () => resolve('exited')));
  request(child);
  const controller = new AbortController();
  const timer = delay(timeoutMs, 'timeout', { signal: controller.signal }).catch(() => 'exited');
  const outcome = await Promise.race([exited, timer]);
  controller.abort();
  if (outcome === 'timeout') {
    child.kill('SIGKILL');
    await exited;
  }
}

/**
 * @param {number} group a negative process-group id
 * @param {NodeJS.Signals | 0} signal
 * @returns {boolean} whether any process of the group was still there
 */
function signalGroup(group, signal) {
  try {
    process.kill(group, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {number} group
 * @param {number} timeoutMs
 */
async function groupGone(group, timeoutMs) {
  for (let waited = 0; waited < timeoutMs; waited += 100) {
    if (!signalGroup(group, 0)) return true;
    await delay(100);
  }
  return !signalGroup(group, 0);
}

/**
 * `stopProcess` for a child spawned with `detached: true`, which leads its own process group: after
 * the child has exited, wait until every process it started has exited too — SIGINT, then SIGKILL,
 * for any that outlive it. A grandchild still running can still write to a directory that cleanup
 * is about to delete.
 *
 * @param {import('node:child_process').ChildProcess | undefined} child
 * @param {{ request?: (child: import('node:child_process').ChildProcess) => void; timeoutMs?: number }} [options]
 */
export async function stopProcessGroup(child, options = {}) {
  if (child?.pid === undefined) return;
  const group = -child.pid;
  const { timeoutMs = 10_000 } = options;
  await stopProcess(child, options);
  for (const signal of /** @type {const} */ (['SIGINT', 'SIGKILL'])) {
    if (await groupGone(group, timeoutMs)) return;
    signalGroup(group, signal);
  }
  await groupGone(group, timeoutMs);
}
