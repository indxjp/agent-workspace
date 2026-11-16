import { serve } from './token-exchange.transport.test-support';
import { expect, it, vi } from 'vitest';
import type { TokenExchangeFixture } from './token-exchange.fixture.test-support';

export function registerTokenExchangeLifetimeTests(
  getFixture: () => Pick<
    TokenExchangeFixture,
    'accessToken' | 'root' | 'workspaceId' | 'clientId' | 'exchange' | 'idToken'
  >,
) {
  it('answers 401 once 300 seconds have passed since issue', async () => {
    const testContext = getFixture();

    const token = await testContext.accessToken();
    expect((await serve('GET', '/api/me', token)).status).toBe(200);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 299_000);
    expect((await serve('GET', '/api/me', token)).status).toBe(200);
    vi.setSystemTime(Date.now() + 2_000);
    expect((await serve('GET', '/api/me', token)).status).toBe(401);
  }, 60_000);

  it('dies with its client: revoking the client kills the token at once', async () => {
    const testContext1 = getFixture();

    const token = await testContext1.accessToken();
    expect((await serve('GET', '/api/me', token)).status).toBe(200);
    if (testContext1.root === undefined) throw new Error('no database root');
    const scope = await testContext1.root.scopes.forWorkspaceId(testContext1.workspaceId);
    if (scope === null) throw new Error('workspace did not resolve');
    await testContext1.root.endpointClients
      .forScope(scope)
      .revoke(testContext1.clientId, new Date());
    expect((await serve('GET', '/api/me', token)).status).toBe(401);
    const again = await testContext1.exchange(await testContext1.idToken('person-sub'));
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ error: { code: 'invalid_client' } });
  }, 60_000);
}
