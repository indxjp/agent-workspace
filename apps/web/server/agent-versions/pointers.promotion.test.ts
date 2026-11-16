import { describe, expect, it } from 'vitest';

import { setAgentPointer } from './pointers';
import { ACTOR, agentWithVersions, barOf, harness } from './pointers.test-support';

describe('setAgentPointer: the promotion gate on production (issue #619)', () => {
  async function gated() {
    const h = await harness();
    const agent = await agentWithVersions(h, { instructions: 'Version one.' });
    const listing = await h.store.list(agent.id);
    const versionId = listing?.versions[0]?.id;
    if (versionId === undefined) throw new Error('version 1 is saved');
    const deps = { store: h.store, ceiling: barOf(0.9) };
    const point = (environment: 'local' | 'production') =>
      setAgentPointer({ environment, version: 1 }, agent, ACTOR, deps);
    return { h, versionId, point };
  }

  it('refuses 409 promotion_not_evaluated for an unevaluated version, and moves nothing', async () => {
    const { h, point } = await gated();
    expect(await point('production')).toMatchObject({
      status: 409,
      body: { error: { code: 'promotion_not_evaluated', details: ['version:1', 'bar:0.9'] } },
    });
    expect(h.provider.pointerCount()).toBe(0);
    expect(h.provider.audits()).toEqual([]);
  });

  it('refuses 409 promotion_gate_failed below the bar, then moves once a newer evaluation passes', async () => {
    const { h, versionId, point } = await gated();
    h.provider.recordEvaluation(versionId, {
      score: 0.7,
      passed: 7,
      total: 10,
      failing: ['no refund promises', 'tone'],
    });
    const refused = await point('production');
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      error: {
        code: 'promotion_gate_failed',
        details: ['version:1', 'score:0.7', 'bar:0.9', 'case:no refund promises', 'case:tone'],
      },
    });
    h.provider.recordEvaluation(versionId, { score: 0.9, passed: 9, total: 10, failing: ['tone'] });
    expect((await point('production')).status).toBe(200);
  });

  it('never gates local', async () => {
    const { point } = await gated();
    expect((await point('local')).status).toBe(200);
  });
});
