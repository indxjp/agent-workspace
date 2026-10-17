import { describe, expect, it } from 'vitest';

import {
  BROWSER_TOKEN_ID_LENGTH,
  BROWSER_TOKEN_PREFIX,
  BROWSER_TOKEN_SECRET_LENGTH,
  mintBrowserToken,
  parsePresentedBrowserToken,
  presentedBrowserTokenText,
  readBearerBrowserTokenAttempt,
} from './browser-token';

describe('the browser-token format follows api-key.ts’s anchored fixed-length grammar', () => {
  it('mints a token that its own parser reads back, both halves at their fixed lengths', async () => {
    const minted = await mintBrowserToken();
    const parsed = parsePresentedBrowserToken(minted.presented);
    expect(parsed).not.toBeNull();
    expect(parsed?.tokenId.length).toBe(BROWSER_TOKEN_ID_LENGTH);
    expect(parsed?.secret.length).toBe(BROWSER_TOKEN_SECRET_LENGTH);
    expect(minted.presented.startsWith(BROWSER_TOKEN_PREFIX)).toBe(true);
    expect(parsed === null ? null : presentedBrowserTokenText(parsed)).toBe(minted.presented);
  });

  it('rejects a wrong prefix, a wrong length, a non-base64url character and a non-string', async () => {
    const minted = await mintBrowserToken();
    const parsed = parsePresentedBrowserToken(minted.presented);
    if (parsed === null) throw new Error('a freshly minted token did not parse');
    const negatives: [string, unknown][] = [
      ['empty', ''],
      ['prefix only', BROWSER_TOKEN_PREFIX],
      ['wrong prefix (api key)', `ak_live_${parsed.tokenId}_${parsed.secret}`],
      ['wrong env', `awt_test_${parsed.tokenId}_${parsed.secret}`],
      ['tokenId one short', `${BROWSER_TOKEN_PREFIX}${parsed.tokenId.slice(1)}_${parsed.secret}`],
      ['tokenId one long', `${BROWSER_TOKEN_PREFIX}${parsed.tokenId}A_${parsed.secret}`],
      ['secret one short', `${BROWSER_TOKEN_PREFIX}${parsed.tokenId}_${parsed.secret.slice(1)}`],
      ['secret one long', `${BROWSER_TOKEN_PREFIX}${parsed.tokenId}_${parsed.secret}A`],
      ['non-base64url char', `${BROWSER_TOKEN_PREFIX}${parsed.tokenId}_${parsed.secret.slice(1)}$`],
      ['trailing newline', `${minted.presented}\n`],
      ['embedded NUL', `${minted.presented}\u0000`],
      ['not a string', 42],
      ['null', null],
      ['undefined', undefined],
      ['an object shaped like one', { tokenId: parsed.tokenId, secret: parsed.secret }],
    ];
    const accepted = negatives
      .filter(([, value]) => parsePresentedBrowserToken(value) !== null)
      .map(([label]) => label);
    expect(accepted, 'these malformed presentations were accepted').toEqual([]);
  });

  it('reads a bearer header case-insensitively and refuses anything else', async () => {
    const minted = await mintBrowserToken();
    expect(readBearerBrowserTokenAttempt(`Bearer ${minted.presented}`)).toMatchObject({
      kind: 'presented',
    });
    expect(readBearerBrowserTokenAttempt(`bearer ${minted.presented}`)).toMatchObject({
      kind: 'presented',
    });
    expect(readBearerBrowserTokenAttempt(null)).toEqual({ kind: 'absent' });
    expect(readBearerBrowserTokenAttempt(undefined)).toEqual({ kind: 'absent' });
    for (const header of [
      minted.presented,
      `Basic ${minted.presented}`,
      `Bearer  ${minted.presented}`,
      `Bearer ${minted.presented} extra`,
      'Bearer malformed',
      42,
    ]) {
      expect(
        readBearerBrowserTokenAttempt(header),
        `did not fail closed for ${JSON.stringify(header)}`,
      ).toEqual({ kind: 'invalid' });
    }
  });

  it('does not confuse a well-formed API key for a browser token, or vice versa', async () => {
    const { mintApiKey } = await import('./api-key');
    const apiKey = await mintApiKey();
    expect(parsePresentedBrowserToken(apiKey.presented)).toBeNull();
    const browserToken = await mintBrowserToken();
    const { parsePresentedKey } = await import('./api-key');
    expect(parsePresentedKey(browserToken.presented)).toBeNull();
  });
});
