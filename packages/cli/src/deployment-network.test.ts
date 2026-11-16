import { createServer } from 'node:net';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  daemonSocketGroupId,
  DOCKER_CONTEXT_INSPECT_TIMEOUT_MS,
  DOCKER_SOCKET_GROUP_PROBE_TIMEOUT_MS,
  dockerEndpoint,
  hostPortFree,
  parseEnvironment,
  webUrl,
  type DockerCommand,
} from './deployment.js';

const childProcess = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

vi.mock('node:child_process', () => childProcess);

const ref = (name: string, digit: string) => `registry.example/${name}@sha256:${digit.repeat(64)}`;

describe('webUrl', () => {
  it('answers on this machine at PORT, or 3000 when .env leaves it empty', () => {
    expect(webUrl({ PORT: '3310' })).toBe('http://127.0.0.1:3310');
    expect(webUrl({})).toBe('http://127.0.0.1:3000');
    expect(webUrl({ PORT: '' })).toBe('http://127.0.0.1:3000');
    expect(webUrl({ PORT: '127.0.0.1:3000' })).toBe('http://127.0.0.1:3000');
  });

  it('answers on the remote Docker host a tcp:// or ssh:// DOCKER_HOST names', () => {
    expect(webUrl({ PORT: '3310' }, 'tcp://10.0.0.5:2375')).toBe('http://10.0.0.5:3310');
    expect(webUrl({}, 'ssh://ops@docker.internal')).toBe('http://docker.internal:3000');
  });

  it('keeps this machine for a local socket or pipe', () => {
    expect(webUrl({}, 'unix:///var/run/docker.sock')).toBe('http://127.0.0.1:3000');
    expect(webUrl({}, 'npipe:////./pipe/docker_engine')).toBe('http://127.0.0.1:3000');
  });
});

describe('dockerEndpoint', () => {
  const inspectCalls: NodeJS.ProcessEnv[] = [];
  const context =
    (stdout: string, status = 0) =>
    (environment: NodeJS.ProcessEnv) => {
      inspectCalls.push(environment);
      return { status, stdout };
    };

  it('takes DOCKER_HOST from the environment compose runs with, .env included', () => {
    const shell: NodeJS.ProcessEnv = { DOCKER_HOST: 'tcp://shell:2375' };
    const dotEnv = parseEnvironment('DOCKER_HOST=tcp://dotenv:2375\n');
    const merged = { ...shell, ...dotEnv };
    expect(dockerEndpoint(merged, context('unix:///ignored'))).toBe('tcp://dotenv:2375');
    expect(webUrl({ PORT: '3417' }, dockerEndpoint(merged, context('')))).toBe(
      'http://dotenv:3417',
    );
  });

  it("falls back to the current docker context's endpoint when DOCKER_HOST is unset", () => {
    inspectCalls.length = 0;
    const environment = { DOCKER_CONTEXT: 'remote' };
    expect(dockerEndpoint(environment, context('ssh://ops@build-host\n'))).toBe(
      'ssh://ops@build-host',
    );
    expect(inspectCalls).toEqual([environment]);
    expect(dockerEndpoint({ DOCKER_HOST: '' }, context('tcp://ctx:2376'))).toBe('tcp://ctx:2376');
  });

  it('is undefined when the context cannot be read, so the URL stays on this machine', () => {
    expect(dockerEndpoint({}, context('', 1))).toBeUndefined();
    expect(webUrl({}, dockerEndpoint({}, context('', 1)))).toBe('http://127.0.0.1:3000');
  });
});

describe('docker context inspection', () => {
  beforeEach(() => {
    childProcess.spawnSync.mockReset();
    childProcess.spawnSync.mockReturnValue({ status: 1, stdout: '' });
  });

  it('bounds `docker context inspect` so a stuck docker CLI cannot hang start', () => {
    expect(dockerEndpoint({})).toBeUndefined();
    expect(childProcess.spawnSync).toHaveBeenCalledWith(
      'docker',
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      expect.objectContaining({ timeout: DOCKER_CONTEXT_INSPECT_TIMEOUT_MS }),
    );
  });
});

describe('daemonSocketGroupId', () => {
  const answer =
    (stdout: string, status: number | null = 0): DockerCommand =>
    () => ({ status, stdout });

  /** #389: the group comes from the daemon's own socket, not this machine's file. */
  it("stats the daemon's socket in a container of the pinned image, bounded by a timeout", () => {
    const run = vi.fn<DockerCommand>(answer('2375\n'));
    const environment = { DOCKER_HOST: 'tcp://dind:2375' };
    expect(daemonSocketGroupId(environment, ref('postgres', '5'), run)).toBe(2375);
    expect(run).toHaveBeenCalledWith(
      [
        'run',
        '--rm',
        '--quiet',
        '--network',
        'none',
        '--entrypoint',
        'stat',
        '--volume',
        '/var/run/docker.sock:/var/run/docker.sock:ro',
        ref('postgres', '5'),
        '-c',
        '%g',
        '/var/run/docker.sock',
      ],
      { env: environment, timeout: DOCKER_SOCKET_GROUP_PROBE_TIMEOUT_MS },
    );
  });

  it('is undefined when the daemon fails, times out or answers something else', () => {
    expect(daemonSocketGroupId({}, ref('postgres', '5'), answer('', 125))).toBeUndefined();
    expect(daemonSocketGroupId({}, ref('postgres', '5'), answer('', null))).toBeUndefined();
    expect(daemonSocketGroupId({}, ref('postgres', '5'), answer('docker\n'))).toBeUndefined();
  });
});

describe('hostPortFree', () => {
  it('reads a port another listener holds as taken, and a released one as free', async () => {
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen({ port: 0 }, resolve));
    const address = holder.address();
    if (address === null || typeof address === 'string') throw new Error('no TCP address');
    await expect(hostPortFree(address.port)).resolves.toBe(false);
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    await expect(hostPortFree(address.port)).resolves.toBe(true);
  });
});
