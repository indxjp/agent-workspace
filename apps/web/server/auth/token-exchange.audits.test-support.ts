import { expect, it } from 'vitest';
import type { TokenExchangeFixture } from './token-exchange.fixture.test-support';

export function registerTokenExchangeAuditsTests(
  getFixture: () => Pick<
    TokenExchangeFixture,
    'exchangeAudits' | 'accessToken' | 'personUserId' | 'clientId' | 'idToken' | 'exchange'
  >,
) {
  it('writes one user-token-exchanged row per exchange, with the person acting on the client', async () => {
    const testContext = getFixture();

    const before = (await testContext.exchangeAudits()).length;
    await testContext.accessToken();
    const rows = await testContext.exchangeAudits();
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({
      actorUserId: testContext.personUserId,
      actorLabel: expect.any(String) as unknown,
      subjectId: testContext.clientId,
      subjectLabel: 'portal',
      details: null,
    });
  }, 60_000);

  it('writes no row for a refusal: a stranger, a wrong audience, a wrong issuer', async () => {
    const testContext1 = getFixture();

    const before = (await testContext1.exchangeAudits()).length;
    for (const [token, status, code] of [
      [await testContext1.idToken('stranger-sub'), 403, 'subject_not_member'],
      [await testContext1.idToken('nobody-sub'), 403, 'subject_not_member'],
      [
        await testContext1.idToken('person-sub', { aud: 'another-app' }),
        401,
        'subject_token_wrong_audience',
      ],
      [
        await testContext1.idToken('person-sub', { iss: 'https://evil.example' }),
        401,
        'subject_token_wrong_issuer',
      ],
      [
        await testContext1.idToken('person-sub', { email_verified: false }),
        401,
        'subject_token_invalid',
      ],
    ] as const) {
      const response = await testContext1.exchange(token);
      expect(response.status, code).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
    }
    expect(await testContext1.exchangeAudits()).toHaveLength(before);
  }, 60_000);
}
