import { describe, expect, it } from 'vitest';

import { checkClientCredentials } from './client-auth';
import type { OAuthClient } from './runtime';
import { mintClientSecret } from './tokens';

const CONFIDENTIAL_ID = '0b9f3a52-6f0e-4d7c-9a51-3a7c1e2d4f60';
const PUBLIC_ID = '7d2c1b4a-3e5f-4a6b-8c9d-0e1f2a3b4c5d';

async function fixture() {
  const secret = await mintClientSecret();
  const clients = new Map<string, OAuthClient>([
    [
      CONFIDENTIAL_ID,
      { id: CONFIDENTIAL_ID, clientSecretHash: secret.secretHash } as unknown as OAuthClient,
    ],
    [PUBLIC_ID, { id: PUBLIC_ID, clientSecretHash: null } as unknown as OAuthClient],
  ]);
  const lookups: string[] = [];
  const findClient = (id: string) => {
    lookups.push(id);
    return Promise.resolve(clients.get(id) ?? null);
  };
  return { secret: secret.presented, findClient, lookups };
}

describe('checkClientCredentials, the one OAuth client check (part 06 step 7)', () => {
  it('admits a confidential client with its own secret', async () => {
    const { secret, findClient } = await fixture();
    const checked = await checkClientCredentials(findClient, CONFIDENTIAL_ID, secret);
    expect(checked).toMatchObject({ ok: true, client: { id: CONFIDENTIAL_ID } });
  });

  it('refuses a confidential client with a wrong, malformed or missing secret, naming it', async () => {
    const { secret, findClient } = await fixture();
    const other = (await mintClientSecret()).presented;
    for (const presented of [other, `${secret}x`, 'not-a-secret', '', null]) {
      const checked = await checkClientCredentials(findClient, CONFIDENTIAL_ID, presented);
      expect(checked).toMatchObject({ ok: false, found: { id: CONFIDENTIAL_ID } });
    }
  });

  it('admits a public client only when it presents no secret', async () => {
    const { secret, findClient } = await fixture();
    expect(await checkClientCredentials(findClient, PUBLIC_ID, null)).toMatchObject({
      ok: true,
      client: { id: PUBLIC_ID },
    });
    for (const presented of [secret, '']) {
      expect(await checkClientCredentials(findClient, PUBLIC_ID, presented)).toMatchObject({
        ok: false,
        found: { id: PUBLIC_ID },
      });
    }
  });

  it('refuses an unknown client, and never looks up an id that is not a UUID', async () => {
    const { secret, findClient, lookups } = await fixture();
    expect(
      await checkClientCredentials(findClient, '11111111-2222-4333-8444-555555555555', secret),
    ).toEqual({ ok: false, found: null });
    expect(await checkClientCredentials(findClient, "x' OR 1=1", secret)).toEqual({
      ok: false,
      found: null,
    });
    expect(lookups).toEqual(['11111111-2222-4333-8444-555555555555']);
  });
});
