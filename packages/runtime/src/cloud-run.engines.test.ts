import { describe, expect, it } from 'vitest';

import type { CloudRunResourceClient } from './cloud-run.js';
import { cloudRunDriver, echoConnection } from './cloud-run.test-support.js';

// ENG-07 (#306, ADR-0073 D3): the image is the run's engine's, from a map of two engines.
const TWO_ENGINE_IMAGES = new Map([
  ['claude-agent-sdk', `registry.example/runtime-claude-agent-sdk@sha256:${'a'.repeat(64)}`],
  ['pi', `registry.example/runtime-pi@sha256:${'b'.repeat(64)}`],
]);

describe('cloud-run-service runtime: one image per engine (ENG-07)', () => {
  function recordingClient(images: string[]): CloudRunResourceClient {
    return {
      createService: (spec) => {
        images.push(spec.image);
        const name = `projects/${spec.project}/locations/${spec.region}/services/${spec.serviceId}`;
        return Promise.resolve({ name, url: `https://${spec.serviceId}.a.run.app`, ready: true });
      },
      getService: (name) =>
        Promise.resolve({
          name,
          url: `https://${name.split('/').pop() ?? ''}.a.run.app`,
          ready: true,
        }),
      deleteService: () => Promise.resolve(),
      listServices: () => Promise.resolve([]),
    };
  }

  function driverWith(images: string[]) {
    return cloudRunDriver(recordingClient(images), {
      images: TWO_ENGINE_IMAGES,
      startAgent: (runtime, request) => echoConnection(`${runtime.externalId}:${request}`),
    });
  }

  it("deploys each run's service from its own engine's image", async () => {
    for (const engine of ['claude-agent-sdk', 'pi']) {
      const images: string[] = [];
      await driverWith(images).create({ engine, sessionId: 's', workspacePath: `/ws/${engine}` });
      expect(images).toEqual([TWO_ENGINE_IMAGES.get(engine)]);
    }
  });

  it('refuses an engine with no image before any service is deployed', async () => {
    const images: string[] = [];
    await expect(
      driverWith(images).create({
        engine: 'openai-agents',
        sessionId: 's',
        workspacePath: '/ws/x',
      }),
    ).rejects.toThrow(/no runtime image for engine "openai-agents"/u);
    expect(images).toHaveLength(0);
  });
});
