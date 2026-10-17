/* global fetch, AbortSignal */
/**
 * Deploys `fake-provider-worker.mjs` for a lane (on any host) and waits until it answers. The Cloudflare
 * token reaches wrangler through the environment only; the fake key goes through stdin. Teardown
 * deletes the Worker by name (`resourceNames(...).fakeProvider`), so a failed lane needs no cleanup here.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import {
  retryWorkerPropagation,
  WRANGLER,
  workersDevUrl,
} from '../../../infra/tests/providers/cloudflare-bridge.mjs';
import { spawnChecked } from '../build-deploy-journey/journey.e2e.mjs';

const WORKER = path.resolve(import.meta.dirname, 'fake-provider-worker.mjs');

/** @param {string} workerName */
export function wranglerConfig(workerName) {
  return `${JSON.stringify(
    {
      name: workerName,
      main: WORKER,
      compatibility_date: '2026-10-01',
      compatibility_flags: ['nodejs_compat'],
      workers_dev: true,
    },
    null,
    2,
  )}\n`;
}

/**
 * Polls until the Worker answers `GET /v1/models` with the key: the route and the secret are live.
 *
 * @param {string} url @param {string} key
 */
export async function waitForFakeProvider(
  url,
  key,
  { timeoutMs = 180_000, intervalMs = 5_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const response = await fetch(`${url}/v1/models`, {
        headers: { 'x-api-key': key },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) return;
      last = `HTTP ${String(response.status)}`;
    } catch {
      last = 'network error';
    }
    if (Date.now() + intervalMs > deadline) {
      throw new Error(
        `the fake provider Worker did not answer at ${url}: last ${last ?? 'no answer'}`,
      );
    }
    await delay(intervalMs);
  }
}

/**
 * @param {{ workerName: string, key: string, run?: typeof spawnChecked, retry?: Parameters<typeof retryWorkerPropagation>[1] }} options
 * @returns {Promise<string>} the Worker's workers.dev origin
 */
export async function deployFakeProvider({ workerName, key, run = spawnChecked, retry }) {
  const work = mkdtempSync(path.join(tmpdir(), 'lj-fake-provider-'));
  try {
    const config = path.join(work, 'wrangler.jsonc');
    writeFileSync(config, wranglerConfig(workerName));
    const options = { cwd: work, env: process.env, timeout: 600_000 };
    const deployed = await retryWorkerPropagation(
      () => run('npx', ['--yes', WRANGLER, 'deploy', '--config', config], options),
      retry,
    );
    await retryWorkerPropagation(
      () =>
        run('npx', ['--yes', WRANGLER, 'secret', 'put', 'FAKE_PROVIDER_KEY', '--config', config], {
          ...options,
          input: key,
        }),
      retry,
    );
    const url = workersDevUrl(deployed, workerName);
    await waitForFakeProvider(url, key);
    return url;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
