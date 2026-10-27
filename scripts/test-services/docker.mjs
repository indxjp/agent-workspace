/* global fetch */
import { spawnSync } from 'node:child_process';

import { CLIENT_BACKENDS_SQL } from './postgres-clients.mjs';
import { AZURITE_IMAGE, FAKE_GCS_SERVER_IMAGE, POSTGRES_IMAGE, SEAWEEDFS_IMAGE } from './pins.mjs';
import { freePort, waitForS3Health, waitUntil } from './process.mjs';

/** @typedef {ReturnType<typeof import('./cleanup.mjs').createCleanup>} Cleanup */

/** Whether a Docker daemon answers. Probed once per run, with a timeout. */
export function dockerAvailable() {
  const result = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 20_000 });
  return result.status === 0;
}

/**
 * @param {string[]} args
 * @returns {string}
 */
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`docker ${args[0] ?? ''} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

/**
 * @param {Cleanup} cleanup
 * @param {string} name
 */
function removeOnCleanup(cleanup, name) {
  cleanup.add(`remove container ${name}`, () => {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  });
}

/**
 * @param {string} name
 * @param {string} containerPort
 */
function hostPort(name, containerPort) {
  return docker([
    'inspect',
    '--format',
    `{{(index (index .NetworkSettings.Ports "${containerPort}/tcp") 0).HostPort}}`,
    name,
  ]);
}

/**
 * PostgreSQL 17 in a container on a random loopback port.
 *
 * @param {Cleanup} cleanup
 * @param {string} suffix
 * @returns {Promise<{ url: string; countClients: () => number | null }>}
 */
export async function startDockerPostgres(cleanup, suffix) {
  const name = `aw-test-postgres-${suffix}`;
  removeOnCleanup(cleanup, name);
  docker([
    'run',
    '--rm',
    '-d',
    '--name',
    name,
    '-e',
    'POSTGRES_PASSWORD=postgres',
    '-e',
    'POSTGRES_DB=agent_workspace_test',
    '-p',
    '127.0.0.1::5432',
    POSTGRES_IMAGE,
    // Durability buys nothing in a throwaway container; see postgres-native-child.mjs.
    'postgres',
    '-c',
    'fsync=off',
    '-c',
    'full_page_writes=off',
  ]);
  await waitUntil('PostgreSQL 17', () => {
    const result = spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], {
      stdio: 'ignore',
    });
    return result.status === 0;
  });
  const port = hostPort(name, '5432');
  return {
    url: `postgres://postgres:postgres@127.0.0.1:${port}/agent_workspace_test`,
    countClients: () => {
      const result = spawnSync(
        'docker',
        [
          'exec',
          name,
          'psql',
          '-U',
          'postgres',
          '-d',
          'agent_workspace_test',
          '-Atqc',
          CLIENT_BACKENDS_SQL,
        ],
        { encoding: 'utf8' },
      );
      if (result.status !== 0) return null;
      return Number(result.stdout.trim());
    },
  };
}

/**
 * SeaweedFS `weed mini` (master, volume, filer and S3 gateway in one container) with its S3 port
 * on a random loopback port. See pins.mjs and ADR-0066.
 *
 * @param {Cleanup} cleanup
 * @param {string} suffix
 * @returns {Promise<{ endpoint: string }>}
 */
export async function startDockerSeaweedfs(cleanup, suffix) {
  const name = `aw-test-s3-${suffix}`;
  removeOnCleanup(cleanup, name);
  docker([
    'run',
    '--rm',
    '-d',
    '--name',
    name,
    '-e',
    'AWS_ACCESS_KEY_ID=agent_workspace',
    '-e',
    'AWS_SECRET_ACCESS_KEY=agent_workspace',
    '-p',
    '127.0.0.1::8333',
    SEAWEEDFS_IMAGE,
    'mini',
  ]);
  const endpoint = `http://127.0.0.1:${hostPort(name, '8333')}`;
  await waitForS3Health(endpoint);
  return { endpoint };
}

/** @param {string} url */
async function answers(url) {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Azurite (blob service) and fake-gcs-server on random loopback ports, for the Azure and GCS
 * contract suites and the load test. See pins.mjs; ci.yml starts the same images.
 *
 * @param {Cleanup} cleanup
 * @param {string} suffix
 * @returns {Promise<{ azuriteUrl: string; gcsEndpoint: string }>}
 */
export async function startDockerStorageEmulators(cleanup, suffix) {
  const azurite = `aw-test-azurite-${suffix}`;
  const gcs = `aw-test-gcs-${suffix}`;
  removeOnCleanup(cleanup, azurite);
  removeOnCleanup(cleanup, gcs);
  docker([
    'run',
    '--rm',
    '-d',
    '--name',
    azurite,
    '-p',
    '127.0.0.1::10000',
    AZURITE_IMAGE,
    'azurite-blob',
    '--blobHost',
    '0.0.0.0',
    '--skipApiVersionCheck',
  ]);
  // fake-gcs-server writes its own address into upload URLs, so it must know the host port.
  const gcsPort = String(await freePort());
  const gcsEndpoint = `http://127.0.0.1:${gcsPort}`;
  docker([
    'run',
    '--rm',
    '-d',
    '--name',
    gcs,
    '-p',
    `127.0.0.1:${gcsPort}:4443`,
    FAKE_GCS_SERVER_IMAGE,
    '-scheme',
    'http',
    '-backend',
    'memory',
    '-port',
    '4443',
    '-external-url',
    gcsEndpoint,
  ]);
  const azuriteOrigin = `http://127.0.0.1:${hostPort(azurite, '10000')}`;
  // Azurite answers an unauthenticated request with an HTTP status, so any answer means ready.
  await waitUntil('Azurite', () => answers(azuriteOrigin));
  await waitUntil('fake-gcs-server', async () => {
    try {
      return (await fetch(`${gcsEndpoint}/storage/v1/b?project=aw`)).ok;
    } catch {
      return false;
    }
  });
  return { azuriteUrl: `${azuriteOrigin}/devstoreaccount1`, gcsEndpoint };
}
