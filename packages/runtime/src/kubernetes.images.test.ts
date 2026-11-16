import { describe, expect, it } from 'vitest';
import { createKubernetesDriver, type KubernetesResource } from './kubernetes.js';

const TWO_ENGINE_IMAGES = new Map([
  ['claude-agent-sdk', `registry.example/runtime-claude-agent-sdk@sha256:${'a'.repeat(64)}`],
  ['pi', `registry.example/runtime-pi@sha256:${'b'.repeat(64)}`],
]);

describe('kubernetes runtime: one image per engine (ENG-07)', () => {
  function recordingDriver(created: KubernetesResource[]) {
    return createKubernetesDriver<string, string>({
      images: TWO_ENGINE_IMAGES,
      client: {
        create: (item) => {
          created.push(item);
          return Promise.resolve(item);
        },
        delete: () => Promise.resolve(),
      },
      startAgent: () => {
        throw new Error('not used');
      },
    });
  }

  it("creates each run's pod from its own engine's image", async () => {
    for (const engine of ['claude-agent-sdk', 'pi']) {
      const created: KubernetesResource[] = [];
      await recordingDriver(created).create({
        engine,
        sessionId: 'session',
        workspacePath: `/workspace/${engine}`,
      });
      const pod = created.find((item) => item.kind === 'Pod') as unknown as {
        spec: { containers: Array<{ image: string }> };
      };
      expect(pod.spec.containers[0]?.image).toBe(TWO_ENGINE_IMAGES.get(engine));
    }
  });

  it('refuses an engine with no image before any resource is created', async () => {
    const created: KubernetesResource[] = [];
    await expect(
      recordingDriver(created).create({
        engine: 'openai-agents',
        sessionId: 'session',
        workspacePath: '/workspace/none',
      }),
    ).rejects.toThrow(/no runtime image for engine "openai-agents"/u);
    expect(created).toHaveLength(0);
  });

  it('refuses a config without an engine as the driver, not as an image-map error', async () => {
    const created: KubernetesResource[] = [];
    // A caller outside TypeScript can omit the engine; the published driver must still refuse it.
    const config = { sessionId: 'session', workspacePath: '/workspace/none' } as unknown as {
      engine: string;
      sessionId: string;
      workspacePath: string;
    };
    await expect(recordingDriver(created).create(config)).rejects.toThrow(
      'kubernetes runtime: engine must be a non-empty string.',
    );
    expect(created).toHaveLength(0);
  });
});
