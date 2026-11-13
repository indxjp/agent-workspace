import { client, refusal } from './api-key-quickstart.transport.test-support';
import { expect, it } from 'vitest';

import type { ApiKeyQuickstartFixture } from './api-key-quickstart.fixture.test-support';

export function registerApiKeyQuickstartAuthorizationTests(
  getFixture: () => Pick<ApiKeyQuickstartFixture, 'key' | 'ownerAgentId' | 'builderAgentId'>,
) {
  it('refuses a Builder key an agent another principal owns, as §21 reads "run what it owns"', async () => {
    const testContext = getFixture();

    const problem = await refusal(() =>
      client(testContext.key('builder')).runs.start(testContext.ownerAgentId, { prompt: 'Hello.' }),
    );
    expect(problem.status).toBe(403);
    expect(problem.code).toBe('forbidden');
  });

  it('lets a Viewer key list agents and refuses it a run', async () => {
    const testContext1 = getFixture();

    const aw = client(testContext1.key('viewer'));
    expect((await aw.agents.list()).length).toBe(2);

    const problem = await refusal(() =>
      aw.runs.start(testContext1.builderAgentId, { prompt: 'Hello.' }),
    );
    expect(problem.status).toBe(403);
    expect(problem.code).toBe('forbidden');
  });
}
