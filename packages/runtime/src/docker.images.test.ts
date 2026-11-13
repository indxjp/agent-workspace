import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDockerDriver } from './docker.js';
import type { DockerCommand } from './docker.js';
import { commandResult, networkInspection } from './docker.test-support.js';

const TWO_ENGINE_IMAGES = new Map([
  ['claude-agent-sdk', `registry.example/runtime-claude-agent-sdk@sha256:${'a'.repeat(64)}`],
  ['pi', `registry.example/runtime-pi@sha256:${'b'.repeat(64)}`],
]);

describe('docker runtime: one image per engine (ENG-07)', () => {
  function recordingDocker(calls: string[][]): DockerCommand {
    let next = 0;
    return (args) => {
      calls.push([...args]);
      if (args[0] === 'network' && args[1] === 'inspect')
        return Promise.resolve(networkInspection('agent-egress'));
      if (args[0] === 'run') return Promise.resolve(commandResult(0, `c-${String(++next)}\n`));
      if (args[0] === 'rm') return Promise.resolve(commandResult(0));
      return Promise.resolve(commandResult(0, 'true\n'));
    };
  }

  it("starts each run in its own engine's image", async () => {
    const calls: string[][] = [];
    const root = await mkdtemp(path.join(tmpdir(), 'eng07-docker-'));
    const driver = createDockerDriver<never, never>({
      images: TWO_ENGINE_IMAGES,
      startAgent: () => {
        throw new Error('not used');
      },
      docker: recordingDocker(calls),
    });
    try {
      for (const engine of ['claude-agent-sdk', 'pi']) {
        calls.length = 0;
        await driver.create({ engine, sessionId: engine, workspacePath: path.join(root, engine) });
        const run = calls.find((call) => call[0] === 'run') ?? [];
        expect(run).toContain(TWO_ENGINE_IMAGES.get(engine));
        for (const [other, image] of TWO_ENGINE_IMAGES) {
          if (other !== engine) expect(run).not.toContain(image);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses an engine with no image before any docker command runs', async () => {
    const calls: string[][] = [];
    const driver = createDockerDriver<never, never>({
      images: TWO_ENGINE_IMAGES,
      startAgent: () => {
        throw new Error('not used');
      },
      docker: recordingDocker(calls),
    });
    await expect(
      driver.create({ engine: 'openai-agents', sessionId: 's', workspacePath: '/tmp/eng07-none' }),
    ).rejects.toThrow(/no runtime image for engine "openai-agents"/u);
    expect(calls.filter((call) => call[0] === 'run')).toHaveLength(0);
  });
});
