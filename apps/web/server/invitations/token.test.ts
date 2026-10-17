import { describe, expect, it } from 'vitest';

import { hashInvitationToken, mintInvitationToken } from './token';

describe('invitation tokens', () => {
  it('mints independent random presentation values and stores only deterministic hashes', async () => {
    const first = await mintInvitationToken();
    const second = await mintInvitationToken();

    expect(first.token).not.toBe(second.token);
    expect(first.tokenHash).not.toBe(second.tokenHash);
    expect(first.tokenHash).not.toContain(first.token);
    expect(first.tokenHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(await hashInvitationToken(first.token)).toBe(first.tokenHash);
  });
});
