import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDockerRunArgs, DOCKER_DEFAULT_WORKSPACE_MB } from './docker.js';
import { includesSequence, runSpec, recordingDriver } from './docker.test-support.js';

describe('docker driver workspace bound (#783)', () => {
  const baseArgs = {
    name: 'probe',
    image: 'alpine:3.20',
    workspacePath: '/srv/ws',
    networkPolicy: 'none',
    networkName: 'agent-egress',
  } as const;

  it('mounts a sized tmpfs for anonymous-volume and no volume mount', () => {
    const args = buildDockerRunArgs({
      ...baseArgs,
      workspaceStorage: 'anonymous-volume',
      workspaceMb: 512,
    });
    expect(
      includesSequence(args, [
        '--tmpfs',
        '/workspace:rw,exec,nosuid,nodev,size=512m,uid=1000,gid=1000,mode=0700',
      ]),
    ).toBe(true);
    expect(args.some((arg) => arg.includes('type=volume'))).toBe(false);
    expect(args).not.toContain('--mount');
  });

  it('sizes --memory as the agent budget plus the tmpfs workspace, and leaves bind alone', () => {
    expect(
      includesSequence(
        buildDockerRunArgs({
          ...baseArgs,
          workspaceStorage: 'anonymous-volume',
          memoryMb: 2_048,
          workspaceMb: 512,
        }),
        ['--memory', '2560m'],
      ),
    ).toBe(true);
    expect(
      includesSequence(buildDockerRunArgs({ ...baseArgs, workspaceStorage: 'anonymous-volume' }), [
        '--memory',
        `${String(1_024 + DOCKER_DEFAULT_WORKSPACE_MB)}m`,
      ]),
    ).toBe(true);
    expect(includesSequence(buildDockerRunArgs(baseArgs), ['--memory', '1g'])).toBe(true);
  });

  it('applies the default size, and read-only when the filesystem is read-only', () => {
    const args = buildDockerRunArgs({
      ...baseArgs,
      workspaceStorage: 'anonymous-volume',
      filesystem: 'read-only',
    });
    expect(args).toContain(
      `/workspace:ro,exec,nosuid,nodev,size=${String(DOCKER_DEFAULT_WORKSPACE_MB)}m,uid=1000,gid=1000,mode=0700`,
    );
  });

  it('forwards diskMb to the run vector for anonymous-volume', async () => {
    const calls: string[][] = [];
    const driver = recordingDriver(calls);
    await driver.create({
      sessionId: 's',
      engine: 'claude-agent-sdk',
      workspacePath: '/ws/s',
      runSpec: runSpec({ diskMb: 2_048 }),
    });
    const run = calls.find((call) => call[0] === 'run') ?? [];
    expect(run).toContain('/workspace:rw,exec,nosuid,nodev,size=2048m,uid=1000,gid=1000,mode=0700');
  });

  it('falls back to an unbounded bind mount without diskMb and refuses diskMb on bind', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'a3-docker-bind-'));
    try {
      const calls: string[][] = [];
      const driver = recordingDriver(calls, { workspaceStorage: 'bind' });
      await driver.create({
        sessionId: 'plain',
        engine: 'claude-agent-sdk',
        workspacePath: path.join(root, 'plain'),
      });
      const run = calls.find((call) => call[0] === 'run') ?? [];
      expect(run).toContain(`type=bind,src=${path.join(root, 'plain')},dst=/workspace`);
      expect(run.some((arg) => arg.startsWith('/workspace:'))).toBe(false);

      calls.length = 0;
      await expect(
        driver.create({
          sessionId: 'sized',
          engine: 'claude-agent-sdk',
          workspacePath: path.join(root, 'sized'),
          runSpec: runSpec({ diskMb: 512 }),
        }),
      ).rejects.toThrow(/anonymous-volume/u);
      expect(calls.some((call) => call[0] === 'run')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([0, 15, 1.5, Number.NaN])(
    'refuses diskMb %s before any docker command',
    async (diskMb) => {
      const calls: string[][] = [];
      const driver = recordingDriver(calls);
      await expect(
        driver.create({
          sessionId: 's',
          engine: 'claude-agent-sdk',
          workspacePath: '/ws/s',
          runSpec: runSpec({ diskMb }),
        }),
      ).rejects.toThrow(/diskMb must be a safe integer/u);
      expect(calls).toEqual([]);
    },
  );
});
