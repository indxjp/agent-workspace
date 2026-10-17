import { spawnSync } from 'node:child_process';

import { CLIENT_BACKENDS_SQL } from './postgres-clients.mjs';
import { POSTGRES_IMAGE, SEAWEEDFS_IMAGE } from './pins.mjs';
import { waitForS3Health, waitUntil } from './process.mjs';

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
