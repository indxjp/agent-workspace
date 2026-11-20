import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DockerCommand } from './docker.js';
import { createFakeDockerDriver } from './docker.driver.test-support.js';
import { commandResult, networkInspection } from './docker.test-support.js';

describe('Docker network validation', () => {
  it.each([
    ['non-internal', networkInspection('agent-egress', { Internal: false }), /not internal/u],
    ['wrong-driver', networkInspection('agent-egress', { Driver: 'overlay' }), /bridge/u],
    ['unowned', networkInspection('agent-egress', { Labels: {} }), /ownership label/u],
    ['wrong-name', networkInspection('other-network'), /name does not match/u],
    ['malformed', commandResult(0, '{not-json'), /malformed JSON/u],
    ['empty-result', commandResult(0, '[]'), /exactly one network/u],
  ])(
    'refuses an existing %s network before starting a container',
    async (_case, inspection, error) => {
      const calls: string[][] = [];
      const docker: DockerCommand = (args) => {
        calls.push([...args]);
        if (args[0] === 'network' && args[1] === 'inspect') return Promise.resolve(inspection);
        return Promise.resolve(commandResult(1, '', 'must not be called'));
      };
      const root = await mkdtemp(path.join(tmpdir(), 'w3-docker-invalid-network-'));
      const driver = createFakeDockerDriver(docker);
      try {
        await expect(
          driver.create({
            engine: 'claude-agent-sdk',
            sessionId: 'network-check',
            workspacePath: root,
          }),
        ).rejects.toThrow(error);
        expect(calls.some((call) => call[0] === 'run')).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('validates the winner of a network create race before trusting it', async () => {
    const calls: string[][] = [];
    let inspectCount = 0;
    const docker: DockerCommand = (args) => {
      calls.push([...args]);
      if (args[0] === 'network' && args[1] === 'inspect') {
        inspectCount += 1;
        return Promise.resolve(
          inspectCount === 1
            ? commandResult(1, '', 'not found')
            : networkInspection('agent-egress'),
        );
      }
      if (args[0] === 'network' && args[1] === 'create') {
        return Promise.resolve(commandResult(1, '', 'already exists'));
      }
      if (args[0] === 'run') return Promise.resolve(commandResult(0, 'container-race-winner\n'));
      return Promise.resolve(commandResult(1, '', 'unexpected command'));
    };
    const root = await mkdtemp(path.join(tmpdir(), 'w3-docker-network-race-'));
    const driver = createFakeDockerDriver(docker);
    try {
      await expect(
        driver.create({ engine: 'claude-agent-sdk', sessionId: 'race', workspacePath: root }),
      ).resolves.toMatchObject({
        externalId: 'container-race-winner',
      });
      expect(calls.filter((call) => call.slice(0, 2).join(' ') === 'network inspect')).toHaveLength(
        2,
      );
      expect(calls.find((call) => call.slice(0, 2).join(' ') === 'network create')).toEqual([
        'network',
        'create',
        '--driver',
        'bridge',
        '--internal',
        '--label',
        'agent-workspace.runtime=docker-network',
        'agent-egress',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
