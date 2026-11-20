import { describe, expect, it } from 'vitest';
import { buildDockerRunArgs } from './docker.js';
import type { DockerCommand, DockerCommandResult } from './docker.js';
import type { RuntimeRunSpec } from './driver.js';
import { createFakeDockerDriver } from './docker.driver.test-support.js';
import { commandResult, includesSequence } from './docker.test-support.js';

describe("publish: 'loopback' (#786)", () => {
  const openSpec: RuntimeRunSpec = {
    runtimeProfileId: 'rp-docker',
    driver: 'docker',
    networkPolicy: 'open',
    filesystem: 'read-write',
    diskMb: 1024,
  };
  function publishingDriver(port: DockerCommandResult) {
    const calls: string[][] = [];
    const docker: DockerCommand = (args) => {
      calls.push([...args]);
      if (args[0] === 'run') return Promise.resolve(commandResult(0, 'container-p\n'));
      if (args[0] === 'port') return Promise.resolve(port);
      if (args[0] === 'rm') return Promise.resolve(commandResult(0));
      return Promise.resolve(commandResult(1, '', 'unexpected command'));
    };
    const driver = createFakeDockerDriver(docker, {
      publish: 'loopback',
      workspaceStorage: 'anonymous-volume',
    });
    return { calls, driver };
  }
  const config = { sessionId: 's', engine: 'claude-agent-sdk', workspacePath: '/unused' };

  it('publishes the runtime port on 127.0.0.1 and answers where docker put it', async () => {
    const { calls, driver } = publishingDriver(commandResult(0, '127.0.0.1:49153\n'));
    const handle = await driver.create({ ...config, runSpec: openSpec });
    const run = calls.find((call) => call[0] === 'run') ?? [];
    expect(includesSequence(run, ['--publish', '127.0.0.1::8080/tcp'])).toBe(true);
    expect(includesSequence(run, ['--add-host', 'host.docker.internal:host-gateway'])).toBe(true);
    expect(includesSequence(run, ['--network', 'bridge'])).toBe(true);
    // No environment crosses into the sandbox: a run's gateway URL and token come in its request.
    expect(run.filter((arg) => arg === '-e' || arg.startsWith('--env'))).toEqual([]);
    expect(calls).toContainEqual(['port', 'container-p', '8080/tcp']);
    expect(driver.publishedOrigin(handle)).toBe('http://127.0.0.1:49153');
    await driver.destroy(handle);
    expect(() => driver.publishedOrigin(handle)).toThrow(/no longer live/u);
  });

  it('removes the sandbox and fails the create when the published port cannot be read', async () => {
    const { calls, driver } = publishingDriver(commandResult(1, '', 'no public port'));
    await expect(driver.create({ ...config, runSpec: openSpec })).rejects.toThrow(
      /published runtime port failed: no public port/u,
    );
    expect(calls).toContainEqual(['rm', '--force', '--volumes', 'container-p']);
  });

  it('refuses a policy whose internal network publishes nothing, before starting anything', async () => {
    const { calls, driver } = publishingDriver(commandResult(0, '127.0.0.1:49153\n'));
    await expect(
      driver.create({ ...config, runSpec: { ...openSpec, networkPolicy: 'none' } }),
    ).rejects.toThrow(/needs network policy open/u);
    expect(calls).toEqual([]);
  });

  it('has no published origin without the option', () => {
    const { driver } = publishingDriver(commandResult(0));
    const plain = buildDockerRunArgs({
      name: 'n',
      image: 'i',
      workspacePath: '/w',
      networkPolicy: 'open',
      networkName: 'agent-egress',
    });
    expect(plain).not.toContain('--publish');
    expect(() =>
      driver.publishedOrigin({
        id: 'x',
        driver: 'docker',
        externalId: 'y',
        workspacePath: '/w',
        createdAt: new Date(),
      }),
    ).toThrow(/no longer live/u);
  });
});
