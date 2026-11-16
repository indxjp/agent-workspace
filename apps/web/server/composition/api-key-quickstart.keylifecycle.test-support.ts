import {
  PINNED_NOW,
  reachedRoutes,
  client,
  refusal,
} from './api-key-quickstart.transport.test-support';
import { expect, it, vi } from 'vitest';

import type { ApiKeyQuickstartFixture } from './api-key-quickstart.fixture.test-support';

export function registerApiKeyQuickstartKeyLifecycleTests(
  getFixture: () => Pick<ApiKeyQuickstartFixture, 'key' | 'builderAgentId'>,
) {
  it('refuses a revoked key at the route, after the edge admitted its shape', async () => {
    const testContext = getFixture();

    reachedRoutes.length = 0;
    const aw = client(testContext.key('revoked'));
    for (const call of [
      () => aw.agents.list(),
      () => aw.runs.start(testContext.builderAgentId, { prompt: 'Hello.' }),
    ]) {
      const problem = await refusal(call);
      expect(problem.status).toBe(401);
      expect(problem.code).toBe('unauthenticated');
    }
    // The refusal is the route's own verification, not the edge's shape check.
    expect(reachedRoutes).toEqual([
      'GET /api/agents',
      `POST /api/agents/${testContext.builderAgentId}/runs`,
    ]);
  });

  it('accepts a key before its expiry and refuses one at it, the same way', async () => {
    const testContext1 = getFixture();

    // Only `Date` is pinned: timers, the database driver and the SDK's deadline keep real time.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(PINNED_NOW);

    expect((await client(testContext1.key('expiring')).agents.list()).length).toBe(2);

    const aw = client(testContext1.key('expired'));
    for (const call of [
      () => aw.agents.list(),
      () => aw.runs.start(testContext1.builderAgentId, { prompt: 'Hello.' }),
    ]) {
      const problem = await refusal(call);
      expect(problem.status).toBe(401);
      expect(problem.code).toBe('unauthenticated');
    }
  });

  it('refuses an unknown key that has the right shape', async () => {
    const problem = await refusal(() =>
      client(`ak_live_${'A'.repeat(22)}_${'B'.repeat(43)}`).agents.list(),
    );
    expect(problem.status).toBe(401);
    expect(problem.code).toBe('unauthenticated');
  });
}
