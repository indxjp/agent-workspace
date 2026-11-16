import { describe, expect, it } from 'vitest';

import {
  ACCESS_TOKEN_TYPE,
  ID_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
} from '@indx-workspace/contracts/token-exchange';

import { ApiProblemError, ContractViolationError } from '../errors.js';
import { HttpClient } from '../http.js';
import { fetchDouble, jsonResponse as json, type RecordedRequest } from '../testing.js';
import { AuthClient } from './auth.js';

const CLIENT_ID = '33333333-3333-4333-8333-333333333333';
/** An unsigned, JWT-shaped placeholder: the SDK passes the ID token through without reading it. */
const ID_TOKEN = 'aGVhZGVy.Y2xhaW1z.c2lnbmF0dXJl';
const ACCESS_TOKEN = `awo_live_${'a'.repeat(22)}_${'b'.repeat(43)}`;

const EXCHANGED = {
  access_token: ACCESS_TOKEN,
  issued_token_type: ACCESS_TOKEN_TYPE,
  token_type: 'Bearer',
  expires_in: 300,
};

function client(route: (request: RecordedRequest) => Response | Promise<Response>): {
  readonly auth: AuthClient;
  readonly calls: RecordedRequest[];
} {
  const api = fetchDouble(route);
  const http = new HttpClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'session' },
    fetch: api.fetch,
  });
  return { auth: new AuthClient(http), calls: api.calls };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

/** What a `client_secret_basic` reader recovers from the header (RFC 6749 §2.3.1). */
function decodeBasic(header: string | null | undefined): readonly [string, string] {
  expect(header).toMatch(/^Basic [A-Za-z0-9+/=]+$/u);
  const decoded = atob(String(header).slice('Basic '.length));
  const colon = decoded.indexOf(':');
  const unescape = (value: string) => decodeURIComponent(value.replace(/\+/gu, ' '));
  return [unescape(decoded.slice(0, colon)), unescape(decoded.slice(colon + 1))];
}

describe('AuthClient.exchange (ADR-0161)', () => {
  it('POSTs the RFC 8693 fields as JSON with the client pair as Basic, and returns the token', async () => {
    const { auth, calls } = client(() => json(200, EXCHANGED));
    const exchanged = await auth.exchange({
      clientId: CLIENT_ID,
      clientSecret: 'aws_live_secret',
      idToken: ID_TOKEN,
    });
    expect(exchanged).toEqual(EXCHANGED);
    const [call] = calls;
    expect(call?.method).toBe('POST');
    expect(call?.url.href).toBe('https://aw.example.com/api/auth/token-exchange');
    expect(call?.headers.get('content-type')).toBe('application/json');
    expect(call?.json).toEqual({
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      subject_token: ID_TOKEN,
      subject_token_type: ID_TOKEN_TYPE,
    });
    expect(decodeBasic(call?.headers.get('authorization'))).toEqual([CLIENT_ID, 'aws_live_secret']);
    expect(call?.headers.get('cookie')).toBeNull();
  });

  it('form-urlencodes each half of the pair, so a colon, a plus or non-ASCII survives', async () => {
    const { auth, calls } = client(() => json(200, EXCHANGED));
    const clientSecret = 'p:ss+w rd/é%?&=';
    await auth.exchange({ clientId: 'id:with space', clientSecret, idToken: ID_TOKEN });
    const header = calls[0]?.headers.get('authorization');
    const raw = atob(String(header).slice('Basic '.length));
    expect(raw).toBe('id%3Awith+space:p%3Ass%2Bw+rd%2F%C3%A9%25%3F%26%3D');
    expect(decodeBasic(header)).toEqual(['id:with space', clientSecret]);
  });

  it('puts neither the client secret nor the ID token anywhere but the header and the body', async () => {
    const { auth, calls } = client(() => json(200, EXCHANGED));
    await auth.exchange({
      clientId: CLIENT_ID,
      clientSecret: 'aws_live_secret',
      idToken: ID_TOKEN,
    });
    const [call] = calls;
    expect(call?.url.search).toBe('');
    expect(JSON.stringify(call?.json)).not.toContain('aws_live_secret');
  });

  it('refuses a response the contract does not accept', async () => {
    for (const body of [
      { ...EXCHANGED, access_token: 'awu_live_not-an-access-token' },
      { ...EXCHANGED, expires_in: 3600 },
      { ...EXCHANGED, refresh_token: 'awr_live_x' },
      { ...EXCHANGED, token_type: 'bearer' },
    ]) {
      const { auth } = client(() => json(200, body));
      const error = await failure(
        auth.exchange({ clientId: CLIENT_ID, clientSecret: 's', idToken: ID_TOKEN }),
      );
      expect(error, JSON.stringify(body)).toBeInstanceOf(ContractViolationError);
    }
  });

  it('surfaces a problem envelope as the typed error with its code', async () => {
    const { auth } = client(() =>
      json(403, {
        error: {
          code: 'subject_not_member',
          message: 'The signed-in person is not a member of this workspace.',
        },
      }),
    );
    const error = await failure(
      auth.exchange({ clientId: CLIENT_ID, clientSecret: 'aws_live_secret', idToken: ID_TOKEN }),
    );
    expect(error).toBeInstanceOf(ApiProblemError);
    expect((error as ApiProblemError).status).toBe(403);
    expect((error as ApiProblemError).code).toBe('subject_not_member');
    expect(String((error as Error).message)).not.toContain(ID_TOKEN);
    expect(String((error as Error).message)).not.toContain('aws_live_secret');
  });
});
