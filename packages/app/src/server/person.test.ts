import { fetchDouble, jsonResponse, type RecordedRequest } from '@indx-workspace/sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { resetAppRuntimeForTests, setAppRuntimeForTests } from '../testing/runtime.js';
import { currentPerson } from './person.js';
import { AppServerError } from './problem.js';
import { signInHref } from './sign-in.js';

const WORKSPACE_ID = '44444444-4444-4444-8444-444444444444';
const PRINCIPAL_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const membership = {
  principalId: PRINCIPAL_ID,
  kind: 'membership',
  role: 'builder',
  workspaceId: WORKSPACE_ID,
  userId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  label: 'Aya Ito',
  features: [],
};

function platform(route: (request: RecordedRequest) => Response): RecordedRequest[] {
  const double = fetchDouble(route);
  setAppRuntimeForTests({
    fetch: double.fetch,
    awUrl: 'https://aw.example.com',
    workspaceId: WORKSPACE_ID,
  });
  return double.calls;
}

function requestWith(headers: Record<string, string>): Request {
  return new Request('https://app.example.com/api/tickets', { headers });
}

afterEach(() => {
  resetAppRuntimeForTests();
});

describe('currentPerson', () => {
  it('asks GET /api/me with the bearer and returns the person, in person', async () => {
    const calls = platform(() => jsonResponse(200, membership));
    const found = await currentPerson(requestWith({ authorization: 'Bearer awo_live_abc' }));
    expect(found).toEqual({
      principalId: PRINCIPAL_ID,
      workspaceId: WORKSPACE_ID,
      role: 'builder',
      via: 'person',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.href).toBe('https://aw.example.com/api/me');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer awo_live_abc');
  });

  it('reads the aw_user_token cookie when there is no bearer', async () => {
    const calls = platform(() => jsonResponse(200, membership));
    const found = await currentPerson(
      requestWith({ cookie: 'theme=dark; aw_user_token=awo_live_fromcookie; other=1' }),
    );
    expect(found?.principalId).toBe(PRINCIPAL_ID);
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer awo_live_fromcookie');
  });

  it('prefers the bearer over the cookie', async () => {
    const calls = platform(() => jsonResponse(200, membership));
    await currentPerson(
      requestWith({ authorization: 'Bearer awu_live_bearer', cookie: 'aw_user_token=awo_live_c' }),
    );
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer awu_live_bearer');
  });

  it('awo_live_ uses the access-token kind and awu_live_ the user-token kind', async () => {
    // Both kinds send the token as a bearer and never the browser's cookies.
    const calls = platform(() => jsonResponse(200, membership));
    await currentPerson(requestWith({ authorization: 'Bearer awo_live_access' }));
    await currentPerson(requestWith({ authorization: 'Bearer awu_live_user' }));
    expect(calls.map((call) => call.headers.get('authorization'))).toEqual([
      'Bearer awo_live_access',
      'Bearer awu_live_user',
    ]);
    expect(calls.map((call) => call.init.credentials)).toEqual([undefined, undefined]);
  });

  it.each([
    ['no token', {}],
    ['an API key', { authorization: 'Bearer ak_live_key' }],
    ['an unknown prefix', { authorization: 'Bearer something' }],
    ['a token with stray characters', { authorization: 'Bearer awo_live_a"b' }],
    ['a non-bearer scheme', { authorization: 'Basic YTpi' }],
    ['an empty cookie', { cookie: 'aw_user_token=' }],
  ])('answers null for %s without calling the platform', async (_name, headers) => {
    const calls = platform(() => jsonResponse(200, membership));
    expect(await currentPerson(requestWith(headers))).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('answers null for a member of a workspace the deployment does not serve', async () => {
    platform(() =>
      jsonResponse(200, { ...membership, workspaceId: '55555555-5555-4555-8555-555555555555' }),
    );
    expect(await currentPerson(requestWith({ authorization: 'Bearer awu_live_other' }))).toBeNull();
  });

  it('compares the workspace without regard to case', async () => {
    platform(() => jsonResponse(200, { ...membership, workspaceId: WORKSPACE_ID.toUpperCase() }));
    const found = await currentPerson(requestWith({ authorization: 'Bearer awo_live_upper' }));
    expect(found?.principalId).toBe(PRINCIPAL_ID);
  });

  it('answers null when the platform answers 401', async () => {
    platform(() =>
      jsonResponse(401, { error: { code: 'unauthenticated', message: 'Sign in again.' } }),
    );
    expect(await currentPerson(requestWith({ authorization: 'Bearer awo_live_old' }))).toBeNull();
  });

  it('currentPerson refuses an api-key principal', async () => {
    platform(() => jsonResponse(200, { ...membership, kind: 'api-key', userId: null }));
    expect(await currentPerson(requestWith({ authorization: 'Bearer awu_live_k' }))).toBeNull();
  });

  it('throws upstream_failure for any other platform failure', async () => {
    platform(() => jsonResponse(503, { error: { code: 'service_unavailable', message: 'x' } }));
    await expect(
      currentPerson(requestWith({ authorization: 'Bearer awo_live_x' })),
    ).rejects.toMatchObject({ name: 'AppServerError', code: 'upstream_failure', status: 502 });
    platform(() => jsonResponse(200, { unexpected: true }));
    await expect(
      currentPerson(requestWith({ authorization: 'Bearer awo_live_x' })),
    ).rejects.toBeInstanceOf(AppServerError);
  });

  it('resolves the awo_live_ cookie the sign-in sets, and an expired one to null and the sign-in page (#1510)', async () => {
    // The pair a browser sends back from the callback's `Set-Cookie: aw_user_token=…; HttpOnly`.
    const cookie = 'aw_user_token=awo_live_signedin';
    let expired = false;
    const calls = platform(() =>
      expired
        ? jsonResponse(401, { error: { code: 'unauthenticated', message: 'expired' } })
        : jsonResponse(200, membership),
    );
    expect((await currentPerson(requestWith({ cookie })))?.principalId).toBe(PRINCIPAL_ID);
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer awo_live_signedin');

    expired = true;
    expect(await currentPerson(requestWith({ cookie }))).toBeNull();
    expect(signInHref('/tickets')).toBe('/sign-in?next=%2Ftickets');
  });
});
