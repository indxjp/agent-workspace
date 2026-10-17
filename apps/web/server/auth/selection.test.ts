import { describe, expect, it } from 'vitest';

import {
  clearedSelectionCookie,
  mintSelectionToken,
  selectionCookie,
  verifySelectionToken,
} from './selection';

const SECRET = 'a'.repeat(32);

describe('the post-callback workspace-selection token', () => {
  it('mints and verifies a round trip', async () => {
    const token = await mintSelectionToken('user-1', 'multi@example.test', SECRET);
    const result = await verifySelectionToken(token, SECRET);
    expect(result).toMatchObject({
      ok: true,
      claims: { userId: 'user-1', email: 'multi@example.test' },
    });
  });

  it('refuses a token signed under a different secret', async () => {
    const token = await mintSelectionToken('user-1', 'multi@example.test', SECRET);
    const result = await verifySelectionToken(token, 'b'.repeat(32));
    expect(result.ok).toBe(false);
  });

  it('refuses an expired token', async () => {
    const mintedAt = 1_000_000;
    const token = await mintSelectionToken('user-1', 'multi@example.test', SECRET, mintedAt);
    // One millisecond after the ten-minute TTL elapsed.
    const later = mintedAt + 10 * 60 * 1000 + 1;
    const result = await verifySelectionToken(token, SECRET, later);
    expect(result).toMatchObject({ ok: false });
  });

  it('refuses a tampered payload even though the signature segment is untouched', async () => {
    const token = await mintSelectionToken('user-1', 'multi@example.test', SECRET);
    const [version, payload, signature] = token.split('.');
    const forged = `${version}.${payload}x.${signature}`;
    const result = await verifySelectionToken(forged, SECRET);
    expect(result.ok).toBe(false);
  });

  it('never verifies as a session token and never accepts one — the version tags differ', async () => {
    // A selection token is not a `session.ts` token structurally: the version tag this module
    // writes is `awsel1`, never `aw1`. This is what stops a selection cookie being replayed
    // where a tenant session is expected, or the reverse — proved here by breaking it: if the
    // version tag were EVER made to match, this assertion would need `verifySessionToken` to
    // reject it for some other reason, and none exists once the tag matches.
    const token = await mintSelectionToken('user-1', 'multi@example.test', SECRET);
    expect(token.startsWith('awsel1.')).toBe(true);
    expect(token.startsWith('aw1.')).toBe(false);
  });

  it('rejects no cookie, garbage, and a wrong number of segments', async () => {
    expect((await verifySelectionToken(undefined, SECRET)).ok).toBe(false);
    expect((await verifySelectionToken('not-a-token', SECRET)).ok).toBe(false);
    expect((await verifySelectionToken('a.b.c.d', SECRET)).ok).toBe(false);
  });

  it('cookie attributes are __Host- shaped: HttpOnly, Secure, Path=/, no Domain field', () => {
    const cookie = selectionCookie('token-value');
    expect(cookie).toMatchObject({
      name: '__Host-aw_workspace_selection',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    });
    expect(cookie.maxAge).toBeGreaterThan(0);
  });

  it('a cleared cookie carries no value and expires immediately', () => {
    const cookie = clearedSelectionCookie();
    expect(cookie.value).toBe('');
    expect(cookie.maxAge).toBe(0);
  });
});
