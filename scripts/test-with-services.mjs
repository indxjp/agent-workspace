/**
 * `pnpm test`: build core and the SDK, provide PostgreSQL 17 and an S3 server, run Vitest, and
 * clean up after every exit path — success, failure, SIGINT, SIGTERM and SIGHUP.
 *
 * Each service comes from, in order (scripts/test-services/select.mjs):
 *
 * 1. `TEST_DATABASE_URL` / `TEST_S3_ENDPOINT`, when set (CI sets both and never runs this file);
 * 2. Docker, when `docker info` succeeds: `postgres:17-alpine` and the pinned SeaweedFS image;
 * 3. the native fallback, for hosts without Docker such as the self-hosted `dgx` pool:
 *    `embedded-postgres` (the packages/embedded pin) in a throwaway directory, and the pinned,
 *    checksum-verified SeaweedFS release binary, cached under
 *    `${XDG_CACHE_HOME:-~/.cache}/agent-workspace/seaweedfs/<version>/`.
 *
 * `AW_TEST_SERVICES=docker|native` forces step 2 or 3. ADR-0066 records the decision. Without a
 * Docker daemon, the four suites that drive real containers skip by design — `ci.yml` still runs
 * them: packages/runtime/src/docker.test.ts, packages/runtime/src/registry.test.ts,
 * packages/embedded/src/docker-sandbox.test.ts and
 * apps/web/app/api/runtimes/[id]/runtimes-route.test.ts.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:os';
import process from 'node:process';

import { createCleanup } from './test-services/cleanup.mjs';
import {
  dockerAvailable,
  startDockerPostgres,
  startDockerSeaweedfs,
} from './test-services/docker.mjs';
import { TestServicesError } from './test-services/errors.mjs';
import { waitForPostgresClientsToClose } from './test-services/postgres-clients.mjs';
import { startNativePostgres } from './test-services/postgres-native.mjs';
import { stopProcess } from './test-services/process.mjs';
import { startNativeSeaweedfs } from './test-services/seaweedfs.mjs';
import { selectServices } from './test-services/select.mjs';

const suffix = randomUUID().slice(0, 8);
const cleanup = createCleanup();

/** @param {string} line */
function log(line) {
  process.stderr.write(`[test-services] ${line}\n`);
}

/** @param {unknown} error */
function describe(error) {
  if (error instanceof TestServicesError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/**
 * Run the cleanup, report every step that failed, and exit with `status` (a step that failed turns
 * a green run red: it may have left something behind).
 *
 * @param {number} status
 * @returns {Promise<never>}
 */
async function cleanUpAndExit(status) {
  const failures = await cleanup.run();
  for (const failure of failures) {
    log(`cleanup step "${failure.label}" failed: ${describe(failure.error)}`);
  }
  process.exit(failures.length > 0 && status === 0 ? 1 : status);
}

for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) {
  process.on(signal, () => {
    log(`received ${signal}; stopping the test services`);
    void cleanUpAndExit(128 + constants.signals[signal]);
  });
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {'external' | 'docker' | 'native'} mode
 * @returns {Promise<null | (() => number | null | Promise<number | null>)>}
 */
async function providePostgres(env, mode) {
  if (mode === 'external') return null;
  const postgres =
    mode === 'docker'
      ? await startDockerPostgres(cleanup, suffix)
      : await startNativePostgres(cleanup);
  env['TEST_DATABASE_URL'] = postgres.url;
  return postgres.countClients;
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {'external' | 'docker' | 'native'} mode
 */
async function provideObjectStore(env, mode) {
  if (mode === 'external') return;
  const store =
    mode === 'docker'
      ? await startDockerSeaweedfs(cleanup, suffix)
      : await startNativeSeaweedfs(cleanup, env);
  env['TEST_S3_ENDPOINT'] = store.endpoint;
  env['TEST_S3_ACCESS_KEY_ID'] = 'agent_workspace';
  env['TEST_S3_SECRET_ACCESS_KEY'] = 'agent_workspace';
}

/** @param {Record<string, string | undefined>} env */
function requireFatalUnhandledRejections(env) {
  const existing = env['NODE_OPTIONS']?.trim() ?? '';
  if (/(?:^|\s)--unhandled-rejections(?:=|\s+)strict(?:\s|$)/u.test(existing)) return;
  env['NODE_OPTIONS'] = `${existing} --unhandled-rejections=strict`.trim();
}

/**
 * @param {string} pnpmEntry
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<number>}
 */
function runVitest(pnpmEntry, env) {
  const requested = process.argv.slice(2);
  if (requested[0] === '--') requested.shift();
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child;
  cleanup.add('stop Vitest', () => stopProcess(child));
  child = spawn(process.execPath, [pnpmEntry, 'exec', 'vitest', 'run', ...requested], {
    env,
    stdio: 'inherit',
  });
  const running = child;
  return new Promise((resolve, reject) => {
    running.once('error', reject);
    running.once('close', (code) => resolve(code ?? 1));
  });
}

async function main() {
  const env = { ...process.env };
  const pnpmEntry = process.env['npm_execpath'];
  if (!pnpmEntry) throw new Error('pnpm did not provide npm_execpath to the test launcher.');
  const modes = selectServices({ env, dockerAvailable });
  log(`postgres: ${modes.postgres}`);
  log(`s3: ${modes.s3}`);
  // `@indx-workspace/sdk...` is the SDK and everything it depends on (`contracts`): the web
  // suites reach both through their `dist/` entry points, exactly as they reach `core`.
  const built = spawnSync(
    process.execPath,
    [pnpmEntry, '--filter', '@agent-workspace/core', '--filter', '@indx-workspace/sdk...', 'build'],
    { env, stdio: 'inherit' },
  );
  if (built.status !== 0) {
    throw new Error('The core and SDK packages failed to build before tests.');
  }
  const countClients = await providePostgres(env, modes.postgres);
  await provideObjectStore(env, modes.s3);
  requireFatalUnhandledRejections(env);
  const status = await runVitest(pnpmEntry, env);
  if (status === 0 && countClients !== null) {
    await waitForPostgresClientsToClose(countClients);
  }
  return status;
}

let status = 1;
try {
  status = await main();
} catch (error) {
  log(describe(error));
}
await cleanUpAndExit(status);
