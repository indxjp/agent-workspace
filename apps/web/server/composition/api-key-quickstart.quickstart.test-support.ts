import { client } from './api-key-quickstart.transport.test-support';
import { type RunEventFrame } from '@indx-workspace/sdk';
import { expect, it } from 'vitest';

import type { ApiKeyQuickstartFixture } from './api-key-quickstart.fixture.test-support';

export function registerApiKeyQuickstartQuickstartTests(
  getFixture: () => Pick<ApiKeyQuickstartFixture, 'key' | 'builderAgentId'>,
) {
  it('lists agents, starts a run, follows it to its end and reads the settled record', async () => {
    const testContext = getFixture();

    const aw = client(testContext.key('builder'));

    const agents = await aw.agents.list();
    expect(agents.map((agent) => agent.name).sort()).toEqual(['Researcher', 'Reviewer']);

    const { run } = await aw.runs.start(testContext.builderAgentId, {
      prompt: 'Summarise the three most important things about this workspace.',
    });
    expect(run.status).toBe('queued');

    const frames: RunEventFrame[] = [];
    for await (const frame of aw.runs.follow(run.id, { maxReconnects: 0 })) frames.push(frame);
    expect(frames.some((frame) => frame.kind === 'runtime' && frame.name === 'assistant')).toBe(
      true,
    );
    expect(
      frames.some((frame) => frame.kind === 'run-status' && frame.data.status === 'completed'),
    ).toBe(true);

    const settled = await aw.runs.get(run.id);
    expect(settled.id).toBe(run.id);
    expect(settled.status).toBe('completed');
  }, 60_000);

  it('lets an Owner key run an agent it did not create', async () => {
    const testContext1 = getFixture();

    const { run } = await client(testContext1.key('owner')).runs.start(
      testContext1.builderAgentId,
      { prompt: 'Hello.' },
    );
    expect(run.status).toBe('queued');
  });
}
