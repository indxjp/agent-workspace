import { describe, expect, it, vi } from 'vitest';

import { TOKEN_REFRESH_MARGIN_MS } from './google-adc-token.js';
import {
  createGoogleIdTokenSource,
  IdTokenUnavailableError,
  type IdTokenClient,
} from './google-id-token.js';

const MINUTE = 60_000;
const AUDIENCE = 'https://rt-tool-1.run.app';

function jwt(expMs: number, nonce: number): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part({ exp: Math.floor(expMs / 1000), n: nonce })}.sig`;
}

function harness() {
  const clock = { now: 1_000_000_000 };
  const audiences: string[] = [];
  const client = vi.fn((): Promise<IdTokenClient> =>
    Promise.resolve({
      idTokenProvider: {
        fetchIdToken: (audience) => {
          audiences.push(audience);
          return Promise.resolve(jwt(clock.now + 60 * MINUTE, audiences.length));
        },
      },
    }),
  );
  const source = createGoogleIdTokenSource({ client, now: () => clock.now });
  return { clock, client, source, audiences };
}

describe('the Google ID token source', () => {
  it('caches a token per audience until five minutes before expiry', async () => {
    const { clock, source, audiences } = harness();
    const first = await source(AUDIENCE);
    clock.now += 54 * MINUTE;
    expect(await source(AUDIENCE)).toBe(first);
    expect(audiences).toEqual([AUDIENCE]);
    await source('https://rt-tool-2.run.app');
    expect(audiences).toHaveLength(2);
  });

  it('mints a new token inside the refresh margin', async () => {
    const { clock, source, audiences } = harness();
    const first = await source(AUDIENCE);
    clock.now += 60 * MINUTE - TOKEN_REFRESH_MARGIN_MS;
    expect(await source(AUDIENCE)).not.toBe(first);
    expect(audiences).toHaveLength(2);
  });

  it('shares one fetch between concurrent callers', async () => {
    const { source, audiences } = harness();
    const [a, b] = await Promise.all([source(AUDIENCE), source(AUDIENCE)]);
    expect(a).toBe(b);
    expect(audiences).toHaveLength(1);
  });

  it('does not cache a token whose expiry cannot be read', async () => {
    const fetchIdToken = vi.fn(() => Promise.resolve('opaque-token'));
    const source = createGoogleIdTokenSource({
      client: () => Promise.resolve({ idTokenProvider: { fetchIdToken } }),
    });
    await source(AUDIENCE);
    await source(AUDIENCE);
    expect(fetchIdToken).toHaveBeenCalledTimes(2);
  });

  it('fails with fixed text free of the library message, then retries with a new client', async () => {
    const client = vi
      .fn<() => Promise<IdTokenClient>>()
      .mockRejectedValueOnce(new Error('metadata 169.254.169.254 secret-detail'))
      .mockResolvedValue({ idTokenProvider: { fetchIdToken: () => Promise.resolve('t') } });
    const source = createGoogleIdTokenSource({ client });
    const error: unknown = await source(AUDIENCE).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IdTokenUnavailableError);
    expect(error).toMatchObject({ message: 'A Google ID token could not be obtained.' });
    await expect(source(AUDIENCE)).resolves.toBe('t');
    expect(client).toHaveBeenCalledTimes(2);
  });
});
