import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDockerRunArgs, createDockerDriver, DOCKER_RUNTIME_CAPABILITIES } from './docker.js';
import type { DockerCommand } from './docker.js';
import { createFakeDockerDriver, unusedStartAgent } from './docker.driver.test-support.js';
import {
  commandResult,
  networkInspection,
  includesSequence,
  runSpec,
} from './docker.test-support.js';

describe('Docker command construction', () => {
  it('contains every hardened option transcribed from the section 14.4 command', async () => {
    const spec = await readFile(path.resolve('docs/spec.md'), 'utf8');
    const block = spec.match(/### `docker`[\s\S]*?```bash\s*([\s\S]*?)```/u)?.[1];
    expect(block, 'the section 14.4 docker command must remain present').toBeDefined();

    const specTokens = (block ?? '')
      .split(/\r?\n/u)
      .map((line) => line.trim().replace(/\\$/u, '').trim())
      .filter((line) => line.startsWith('--'))
      .flatMap((line) => line.split(/\s+/u));
    const args = buildDockerRunArgs({
      name: 'probe',
      image: 'agent-workspace/runtime:digest',
      workspacePath: '/srv/workspaces/session',
      networkPolicy: 'none',
      networkName: 'agent-egress',
    });

    for (let index = 0; index < specTokens.length; index += 2) {
      expect(
        includesSequence(args, specTokens.slice(index, index + 2)),
        `missing section 14.4 option ${specTokens.slice(index, index + 2).join(' ')}`,
      ).toBe(true);
    }
  });

  it('keeps gateway reachability for none and never emits Docker network none', () => {
    for (const policy of ['none', 'restricted', 'open'] as const) {
      const args = buildDockerRunArgs({
        name: `probe-${policy}`,
        image: 'alpine:3.20',
        workspacePath: '/workspace',
        networkPolicy: policy,
        networkName: 'agent-egress',
      });
      expect(includesSequence(args, ['--network', 'none'])).toBe(false);
      expect(
        includesSequence(args, ['--network', policy === 'open' ? 'bridge' : 'agent-egress']),
      ).toBe(true);
    }
    expect(DOCKER_RUNTIME_CAPABILITIES.networkPolicyEnforcement.none).toBe('network');
    expect(DOCKER_RUNTIME_CAPABILITIES.networkPolicies).not.toContain('allowlist');
  });

  it('requires immutable production images and applies resolved resource/filesystem constraints', () => {
    expect(() =>
      createDockerDriver({
        images: new Map([['claude-agent-sdk', 'agent-workspace/runtime:latest']]),
        requireDigest: true,
        startAgent: unusedStartAgent,
      }),
    ).toThrow(/pinned by sha256 digest/u);

    const args = buildDockerRunArgs({
      name: 'constrained',
      image: `agent-workspace/runtime@sha256:${'a'.repeat(64)}`,
      workspacePath: '/srv/session',
      networkPolicy: 'none',
      networkName: 'agent-egress',
      runtimeId: 'runtime-1',
      sessionId: 'session-1',
      cpu: 2,
      memoryMb: 2048,
      filesystem: 'read-only',
    });
    expect(includesSequence(args, ['--cpus', '2'])).toBe(true);
    expect(includesSequence(args, ['--memory', '2048m'])).toBe(true);
    expect(args).toContain('type=bind,src=/srv/session,dst=/workspace,readonly');
    expect(includesSequence(args, ['--label', 'agent-workspace.runtime-id=runtime-1'])).toBe(true);
    expect(includesSequence(args, ['--label', 'agent-workspace.session-id=session-1'])).toBe(true);
  });

  it('keeps the validated run spec when its caller replaces it during network inspection', async () => {
    const calls: string[][] = [];
    const config = {
      sessionId: 'validated-spec',
      engine: 'claude-agent-sdk',
      workspacePath: '/workspace/validated-spec',
      runSpec: runSpec({ cpu: 2, memoryMb: 512, diskMb: 128, filesystem: 'read-only' }),
    };
    const docker: DockerCommand = async (args) => {
      calls.push([...args]);
      if (args[0] === 'network' && args[1] === 'inspect') {
        await Promise.resolve();
        config.runSpec = runSpec({ cpu: -1, memoryMb: 1, diskMb: 1 });
        return networkInspection('agent-egress');
      }
      return commandResult(0, args[0] === 'run' ? 'validated-container' : '');
    };
    const driver = createFakeDockerDriver(docker, { workspaceStorage: 'anonymous-volume' });
    const handle = await driver.create(config);
    await driver.destroy(handle);
    const run = calls.find((call) => call[0] === 'run') ?? [];
    expect(includesSequence(run, ['--cpus', '2'])).toBe(true);
    expect(includesSequence(run, ['--memory', '640m'])).toBe(true);
    expect(run).toContain('/workspace:ro,exec,nosuid,nodev,size=128m,uid=1000,gid=1000,mode=0700');
  });

  it('starts exactly one container per handle and removes that container on destroy', async () => {
    const calls: string[][] = [];
    let nextContainer = 0;
    const docker: DockerCommand = (args) => {
      calls.push([...args]);
      if (args[0] === 'network' && args[1] === 'inspect')
        return Promise.resolve(networkInspection('agent-egress'));
      if (args[0] === 'run')
        return Promise.resolve(commandResult(0, `container-${String(++nextContainer)}\n`));
      if (args[0] === 'rm') return Promise.resolve(commandResult(0));
      if (args[0] === 'inspect') return Promise.resolve(commandResult(0, 'true\n'));
      return Promise.resolve(commandResult(1, '', 'unexpected command'));
    };
    const root = await mkdtemp(path.join(tmpdir(), 'w3-docker-unit-'));
    const driver = createFakeDockerDriver(docker);
    try {
      const first = await driver.create({
        sessionId: 'one',
        engine: 'claude-agent-sdk',
        workspacePath: path.join(root, 'one'),
      });
      const second = await driver.create({
        sessionId: 'two',
        engine: 'claude-agent-sdk',
        workspacePath: path.join(root, 'two'),
      });
      expect(calls.filter((call) => call[0] === 'run')).toHaveLength(2);
      expect(first.externalId).not.toBe(second.externalId);
      expect(await driver.isLive(first)).toBe(true);
      await driver.destroy(first);
      await driver.destroy(second);
      expect(calls.filter((call) => call[0] === 'rm')).toEqual([
        ['rm', '--force', '--volumes', 'container-1'],
        ['rm', '--force', '--volumes', 'container-2'],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
