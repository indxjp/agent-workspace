import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { hashApiKeySecret } from '../rbac/api-key';
import { hashShareToken } from './link-token';

describe('hashShareToken (part 06 step 3)', () => {
  it('is the API-key hash: SHA-256 of the UTF-8 token, lower-case hex', async () => {
    const token = 'pub_AbC-123_xyz';
    const expected = createHash('sha256').update(token, 'utf8').digest('hex');
    expect(await hashShareToken(token)).toBe(expected);
    expect(await hashShareToken(token)).toBe(await hashApiKeySecret(token));
  });

  it("matches what PostgreSQL stores for a token (encode(sha256(token::bytea), 'hex'))", async () => {
    // The value `select encode(sha256('pub_abc'::bytea), 'hex')` returns on PostgreSQL 18.
    expect(await hashShareToken('pub_abc')).toBe(
      'c7d08637f051a4f981338b15e68ecb6c3e861ad3bbe18726522a09bbf74dc7f4',
    );
  });
});
