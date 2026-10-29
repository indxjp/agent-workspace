import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

import pg from 'pg';

import { TestServicesError } from './errors.mjs';
import { CLIENT_BACKENDS_SQL } from './postgres-clients.mjs';
import { captureOutput, freePort, stopProcessGroup } from './process.mjs';

/** @typedef {ReturnType<typeof import('./cleanup.mjs').createCleanup>} Cleanup */

const CHILD = path.join(import.meta.dirname, 'postgres-native-child.mjs');
const ATTEMPTS = 3;
const READY_TIMEOUT_MS = 60_000;

/**
 * PostgreSQL 18 from the pinned `embedded-postgres`, in a fresh directory under `os.tmpdir()` on a
 * free 127.0.0.1 port, with `postgres` as its superuser. A start that loses its port to another
 * process is retried on a new port and a new data directory.
 *
 * @param {Cleanup} cleanup
 * @returns {Promise<{ url: string; countClients: () => Promise<number | null> }>}
 */
export async function startNativePostgres(cleanup) {
  /** @type {string | undefined} */
  let root;
  cleanup.add('remove the native PostgreSQL directory', () => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });
  root = mkdtempSync(path.join(os.tmpdir(), 'aw-test-pg-'));
  for (let attempt = 1; ; attempt += 1) {
    const port = await freePort();
    try {
      await startCluster(cleanup, root, path.join(root, `data-${String(attempt)}`), port);
    } catch (error) {
      if (
        attempt < ATTEMPTS &&
        error instanceof TestServicesError &&
        error.code === 'postgres_native_failed'
      ) {
        continue;
      }
      throw error;
    }
    const url = `postgres://postgres:postgres@127.0.0.1:${String(port)}/agent_workspace_test`;
    return { url, countClients: () => countClientBackends(url) };
  }
}

/**
 * @param {Cleanup} cleanup
 * @param {string} root
 * @param {string} dataDir
 * @param {number} port
 */
async function startCluster(cleanup, root, dataDir, port) {
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child;
  const stop = async () => {
    // Closing stdin asks the helper to stop the cluster; see postgres-native-child.mjs. The helper
    // leads its own process group, so initdb or postgres outliving it are found and stopped too.
    await stopProcessGroup(child, { request: (running) => running.stdin?.end() });
  };
  cleanup.add(`stop native PostgreSQL on port ${String(port)}`, stop);
  child = spawn(process.execPath, [CHILD, dataDir, String(port)], {
    // initdb's password file goes to os.tmpdir(); keep it inside the run directory, so an
    // interrupt during initialisation cannot leave it behind.
    env: { ...process.env, TMPDIR: root },
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = captureOutput(child);
  try {
    await waitForReadyLine(child, output);
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {() => string} output
 */
function waitForReadyLine(child, output) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new TestServicesError(
          'test_service_not_ready',
          `Native PostgreSQL did not become ready within ${String(READY_TIMEOUT_MS)} milliseconds.\n${output()}`,
        ),
      );
    }, READY_TIMEOUT_MS);
    let stdout = '';
    child.stdout?.on('data', (/** @type {Buffer} */ chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.includes('{"ready":true}')) {
        clearTimeout(timer);
        resolve(undefined);
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(
        new TestServicesError(
          'postgres_native_failed',
          `Native PostgreSQL exited before it was ready (code ${String(code)}, signal ${String(signal)}).\n${output()}`,
        ),
      );
    });
  });
}

/**
 * The client-close check of the native path: the same `pg_stat_activity` query the Docker path
 * runs through `psql`, sent through `pg`.
 *
 * @param {string} url
 * @returns {Promise<number | null>}
 */
async function countClientBackends(url) {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    const result = await client.query(CLIENT_BACKENDS_SQL);
    return Number(result.rows[0]?.count);
  } catch {
    return null;
  } finally {
    await client.end().catch(() => undefined);
  }
}
