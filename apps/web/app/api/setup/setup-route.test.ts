/**
 * `POST /api/setup` refuses in the one standard envelope (`ApiProblemSchema`, issue #238): a body
 * the route cannot read is its own `400 invalid_setup`, and a refusal from the setup runtime keeps
 * the runtime's status and code. A stub runtime stands in for the persistence the route delegates
 * to, so the route's own mapping is what is under test.
 */
import { ApiProblemSchema } from '@indx-workspace/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resetSignInAttempts,
  SIGN_IN_ATTEMPTS_PER_MINUTE,
} from '../../../server/auth/sign-in-limit';
import {
  configureSetupRuntime,
  type SetupInput,
  type SetupRuntime,
} from '../../../server/setup/runtime';

import { POST } from './route';

const VALID_INPUT: SetupInput = {
  provider: 'anthropic',
  providerApiKey: 'sk-test',
  runtime: 'local',
  adminEmail: 'owner@setup.test',
  adminPassword: 'correct horse battery staple',
  agentName: 'First agent',
  agentInstructions: 'Be helpful.',
};

function setupRequest(body: unknown): Request {
  return new Request('https://control-plane.test/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function install(runtime: SetupRuntime): SetupInput[] {
  const received: SetupInput[] = [];
  configureSetupRuntime({
    complete: async (input) => {
      received.push(input);
      return runtime.complete(input);
    },
  });
  return received;
}

afterEach(() => {
  resetSignInAttempts();
  delete (globalThis as { __agentWorkspaceSetupRuntime__?: SetupRuntime })
    .__agentWorkspaceSetupRuntime__;
});

describe('POST /api/setup refuses in the standard envelope', () => {
  it('answers 429 rate_limited once a client spends its password attempts', async () => {
    install({ complete: () => Promise.reject(new Error('wrong password')) });
    // Without a trusted proxy chain every caller shares one bucket at ten times the limit.
    for (let attempt = 0; attempt < SIGN_IN_ATTEMPTS_PER_MINUTE * 10; attempt += 1) {
      expect((await POST(setupRequest({}))).status).toBe(400);
    }
    const refused = await POST(setupRequest(VALID_INPUT));
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).not.toBeNull();
    expect(await refused.json()).toMatchObject({ error: { code: 'rate_limited' } });
  });

  it('answers 400 invalid_setup to an empty object, without calling the runtime', async () => {
    const received = install({
      complete: () => Promise.reject(new Error('the runtime must not be called')),
    });
    const response = await POST(setupRequest({}));
    expect(response.status).toBe(400);
    const body: unknown = await response.json();
    expect(ApiProblemSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ error: { code: 'invalid_setup' } });
    expect(received).toEqual([]);
  });

  it('keeps a runtime refusal’s status and code: 422 provider_test_failed', async () => {
    const received = install({
      complete: () =>
        Promise.resolve({
          ok: false,
          status: 422,
          code: 'provider_test_failed',
          message: 'The provider rejected the API key.',
        }),
    });
    const response = await POST(setupRequest(VALID_INPUT));
    expect(response.status).toBe(422);
    const body: unknown = await response.json();
    expect(ApiProblemSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      error: { code: 'provider_test_failed', message: 'The provider rejected the API key.' },
    });
    expect(received).toEqual([VALID_INPUT]);
  });
});

describe('POST /api/setup when the runtime throws', () => {
  it('answers a typed 500 setup_failed instead of an empty body, without any secret', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    install({
      complete: () =>
        Promise.reject(
          new TypeError(`fetch failed for ${VALID_INPUT.providerApiKey} at https://db.internal/x`),
        ),
    });
    const response = await POST(setupRequest(VALID_INPUT));
    expect(response.status).toBe(500);
    const text = await response.text();
    const body: unknown = JSON.parse(text);
    expect(ApiProblemSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ error: { code: 'setup_failed' } });
    expect(text).not.toContain(VALID_INPUT.providerApiKey);
    expect(text).not.toContain('db.internal');
    const logged = spy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(logged).toContain('TypeError');
    expect(logged).not.toContain(VALID_INPUT.providerApiKey);
    expect(logged).not.toContain('db.internal');
    spy.mockRestore();
  });
});

describe('POST /api/setup providerBaseUrl', () => {
  const accepted = (): ReturnType<typeof install> =>
    install({ complete: () => Promise.reject(new Error('stop after the route')) });

  it('passes an https base URL to the runtime', async () => {
    const received = accepted();
    await POST(
      setupRequest({ ...VALID_INPUT, providerBaseUrl: 'https://fake.example/proxy' }),
    ).catch(() => undefined);
    expect(received).toEqual([{ ...VALID_INPUT, providerBaseUrl: 'https://fake.example/proxy' }]);
  });

  it.each([
    ['http', 'http://fake.example'],
    ['userinfo', 'https://user:pw@fake.example'],
    ['a query', 'https://fake.example/?key=sk-x'],
    ['a fragment', 'https://fake.example/#x'],
    ['not a URL', 'fake.example'],
    ['empty', ''],
    ['a non-string', 42],
  ])('answers 400 invalid_setup to %s, without calling the runtime', async (_label, value) => {
    const received = accepted();
    const response = await POST(setupRequest({ ...VALID_INPUT, providerBaseUrl: value }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_setup' } });
    expect(received).toEqual([]);
  });
});

describe('POST /api/setup runtimeCredential and runtimeEndpoint', () => {
  const KEY = 'e2b_key_0123456789';
  const pair = { runtimeCredential: KEY, runtimeEndpoint: 'https://api.e2b.dev' };
  const accepted = (): ReturnType<typeof install> =>
    install({ complete: () => Promise.reject(new Error('stop after the route')) });

  it('passes a key and an https endpoint to the runtime', async () => {
    const received = accepted();
    await POST(setupRequest({ ...VALID_INPUT, ...pair })).catch(() => undefined);
    expect(received).toEqual([{ ...VALID_INPUT, ...pair }]);
  });

  it('answers 201 with the id of the runtime connection setup stored', async () => {
    install({
      complete: () =>
        Promise.resolve({
          ok: true,
          agentId: 'agent-1',
          modelConnectionId: 'model-1',
          runtimeProfileId: 'profile-1',
          runtimeConnectionId: 'runtime-connection-1',
          token: 'token',
          cookie: {
            name: 'session',
            value: 'token',
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            path: '/',
            maxAge: 60,
          },
        }),
    });
    const response = await POST(setupRequest({ ...VALID_INPUT, ...pair }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      agentId: 'agent-1',
      modelConnectionId: 'model-1',
      runtimeProfileId: 'profile-1',
      runtimeConnectionId: 'runtime-connection-1',
      runtimeRefusal: null,
    });
  });

  it.each([
    ['a key without an endpoint', { runtimeCredential: KEY }],
    ['an endpoint without a key', { runtimeEndpoint: 'https://api.e2b.dev' }],
    ['an http endpoint', { ...pair, runtimeEndpoint: 'http://api.e2b.dev' }],
    ['an endpoint with userinfo', { ...pair, runtimeEndpoint: 'https://u:pw@api.e2b.dev' }],
    ['an endpoint with a query', { ...pair, runtimeEndpoint: 'https://api.e2b.dev/?k=1' }],
    ['a key with a space', { ...pair, runtimeCredential: 'e2b key' }],
    ['a key with a newline', { ...pair, runtimeCredential: 'e2b\nkey' }],
    ['an empty key', { ...pair, runtimeCredential: '' }],
    ['a non-string key', { ...pair, runtimeCredential: 42 }],
  ])('answers 400 invalid_setup to %s, naming no submitted value', async (_label, fields) => {
    const received = accepted();
    const response = await POST(setupRequest({ ...VALID_INPUT, ...fields }));
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain('invalid_setup');
    expect(text).not.toContain(KEY);
    expect(received).toEqual([]);
  });
});
