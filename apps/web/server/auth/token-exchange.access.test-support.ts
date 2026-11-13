import { serve } from './token-exchange.transport.test-support';
import { expect, it } from 'vitest';

import type { TokenExchangeFixture } from './token-exchange.fixture.test-support';

export function registerTokenExchangeAccessTests(
  getFixture: () => Pick<TokenExchangeFixture, 'accessToken' | 'ungrantedAgent' | 'unboundAgent'>,
) {
  it('is refused for a bound agent the person has no grant to, and for an unbound one', async () => {
    const testContext = getFixture();

    const token = await testContext.accessToken();
    const ungranted = await serve('POST', `/api/agents/${testContext.ungrantedAgent}/runs`, token, {
      prompt: 'Hello.',
    });
    expect(ungranted.status).toBe(403);
    const unbound = await serve('POST', `/api/agents/${testContext.unboundAgent}/runs`, token, {
      prompt: 'Hello.',
    });
    expect(unbound.status).toBe(403);
    expect(await unbound.json()).toMatchObject({ error: { code: 'token_out_of_scope' } });
  }, 60_000);

  it('is not admitted on a route outside the app-backend grammar (ADR-0161 D8, D9)', async () => {
    const testContext1 = getFixture();

    // The wire answer is 401 at admission; decide()'s 403 token_out_of_scope for the same routes is
    // the second layer, proven in token-exchange.test.ts.
    const token = await testContext1.accessToken();
    expect((await serve('GET', '/api/workspaces', token)).status).toBe(401);
    expect((await serve('POST', '/api/files', token, {})).status).toBe(401);
  }, 60_000);
}
