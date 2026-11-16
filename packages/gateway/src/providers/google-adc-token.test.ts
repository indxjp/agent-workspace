import { describe, expect, it, vi } from 'vitest';

import { ModelCredentialUnavailableError } from '../types.js';
import {
  createGoogleAdcTokenSource,
  TOKEN_REFRESH_MARGIN_MS,
  type AdcClient,
} from './google-adc-token.js';

const MINUTE = 60_000;

/** A fake `GoogleAuth` client minting numbered tokens that expire an hour after the fake clock. */
function harness(options: { expiry?: boolean } = {}) {
  const clock = { now: 1_000_000 };
  let minted = 0;
  const clients: AdcClient[] = [];
  const client = vi.fn((): Promise<AdcClient> => {
    const credentials: { expiry_date?: number | null } = {};
    const adc: AdcClient = {
      credentials,
      getAccessToken: () => {
        minted += 1;
        if (options.expiry !== false) credentials.expiry_date = clock.now + 60 * MINUTE;
        return Promise.resolve({ token: `ya29.token-${String(minted)}` });
      },
    };
    clients.push(adc);
    return Promise.resolve(adc);
  });
  const source = createGoogleAdcTokenSource({ client, now: () => clock.now });
  return { clock, client, source, minted: () => minted };
}

describe('the Application Default Credentials token source', () => {
  it('caches the token while it is more than five minutes from expiry', async () => {
    const { clock, source, minted } = harness();
    expect(await source.accessToken()).toBe('ya29.token-1');
    clock.now += 54 * MINUTE;
    expect(await source.accessToken()).toBe('ya29.token-1');
    expect(minted()).toBe(1);
  });

  it('fetches a new token once the expiry is inside the five-minute threshold', async () => {
    const { clock, source } = harness();
    await source.accessToken();
    clock.now += 60 * MINUTE - TOKEN_REFRESH_MARGIN_MS;
    expect(await source.accessToken()).toBe('ya29.token-2');
  });

  it('shares one fetch between concurrent callers', async () => {
    const { source, minted } = harness();
    const tokens = await Promise.all([source.accessToken(), source.accessToken()]);
    expect(tokens).toEqual(['ya29.token-1', 'ya29.token-1']);
    expect(minted()).toBe(1);
  });

  it('invalidate() drops the cache and asks a fresh client', async () => {
    const { source, client } = harness();
    await source.accessToken();
    source.invalidate();
    expect(await source.accessToken()).toBe('ya29.token-2');
    expect(client).toHaveBeenCalledTimes(2);
  });

  it('does not cache a token that reports no expiry', async () => {
    const { source, minted } = harness({ expiry: false });
    await source.accessToken();
    await source.accessToken();
    expect(minted()).toBe(2);
  });

  it('throws a typed error whose message carries neither the token nor the library text', async () => {
    const source = createGoogleAdcTokenSource({
      client: () => Promise.reject(new Error('Could not load the default credentials ya29.leak')),
    });
    const error = await source.accessToken().catch((rejection: unknown) => rejection);
    expect(error).toBeInstanceOf(ModelCredentialUnavailableError);
    expect(String((error as Error).message)).not.toContain('ya29');
    expect(String((error as Error).message)).not.toContain('default credentials');
  });

  it('throws the typed error when the identity returns no token, then recovers', async () => {
    let calls = 0;
    const source = createGoogleAdcTokenSource({
      client: () => {
        calls += 1;
        return Promise.resolve({
          credentials: {},
          getAccessToken: () =>
            Promise.resolve(calls === 1 ? { token: null } : { token: 'ya29.later' }),
        });
      },
    });
    await expect(source.accessToken()).rejects.toBeInstanceOf(ModelCredentialUnavailableError);
    expect(await source.accessToken()).toBe('ya29.later');
  });
});
