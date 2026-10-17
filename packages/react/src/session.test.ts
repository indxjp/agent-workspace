import { describe, expect, it } from 'vitest';

import { openSurfaceSession, postRunFeedback, surfaceSessionsPath, surfaceUrl } from './session.js';

const SESSION = {
  token: `awt_live_${'a'.repeat(22)}_${'b'.repeat(43)}`,
  sessionId: '11111111-1111-4111-8111-111111111111',
  agentId: '22222222-2222-4222-8222-222222222222',
  expiresAt: '2026-10-02T11:00:00.000Z',
};

interface Recorded {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function answering(status: number, body: unknown): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fake = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetch: fake, calls };
}

describe('openSurfaceSession (S1-17, #455)', () => {
  it('POSTs with no body and reads a 201 through the contract', async () => {
    const { fetch, calls } = answering(201, SESSION);
    await expect(openSurfaceSession('main', fetch)).resolves.toEqual({
      kind: 'opened',
      session: SESSION,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/p/s/main/sessions');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it('encodes the name into the path', () => {
    expect(surfaceSessionsPath('a/b')).toBe('/p/s/a%2Fb/sessions');
  });

  it('reads a 404 problem', async () => {
    const { fetch } = answering(404, {
      error: { code: 'surface_not_found', message: 'No surface with that name is served here.' },
    });
    await expect(openSurfaceSession('main', fetch)).resolves.toEqual({
      kind: 'problem',
      status: 404,
      code: 'surface_not_found',
      message: 'No surface with that name is served here.',
      retryAfterSeconds: null,
    });
  });

  it("reads a 429's Retry-After (#622)", async () => {
    const limited = (): Promise<Response> =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: 'surface_rate_limited', message: 'Slow down.' } }),
          { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '17' } },
        ),
      );
    await expect(openSurfaceSession('main', limited)).resolves.toEqual({
      kind: 'problem',
      status: 429,
      code: 'surface_rate_limited',
      message: 'Slow down.',
      retryAfterSeconds: 17,
    });
  });

  it('reads a 422 run-start refusal with its code', async () => {
    const { fetch } = answering(422, {
      error: { code: 'model_connection_unresolved', message: 'no model can be resolved' },
    });
    await expect(openSurfaceSession('main', fetch)).resolves.toMatchObject({
      kind: 'problem',
      status: 422,
      code: 'model_connection_unresolved',
    });
  });

  it('refuses a 201 that is not a session, and an answer that is not JSON', async () => {
    const wrong = answering(201, { ...SESSION, token: 'ak_live_x' });
    await expect(openSurfaceSession('main', wrong.fetch)).resolves.toMatchObject({
      kind: 'failed',
    });
    const html = answering(502, '<html>bad gateway</html>');
    await expect(openSurfaceSession('main', html.fetch)).resolves.toEqual({
      kind: 'failed',
      message: 'The session request failed with HTTP 502.',
    });
  });

  it('reports a request that did not complete', async () => {
    const failing = (): Promise<Response> => Promise.reject(new TypeError('Failed to fetch'));
    await expect(openSurfaceSession('main', failing)).resolves.toEqual({
      kind: 'failed',
      message: 'Failed to fetch',
      unreachable: true,
    });
  });
});

describe('openSurfaceSession with a request (C18, #540)', () => {
  it('sends an empty request as no body', async () => {
    const { fetch, calls } = answering(201, SESSION);
    await openSurfaceSession('main', fetch, {});
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it('sends a resume and an agent as exactly that JSON, and reads a resumed 201', async () => {
    const { fetch, calls } = answering(201, SESSION);
    const request = {
      resume: { sessionId: SESSION.sessionId, resumeKey: 'k'.repeat(43) },
      agent: 'Billing',
    };
    await expect(openSurfaceSession('main', fetch, request)).resolves.toEqual({
      kind: 'opened',
      session: SESSION,
    });
    expect(calls[0]?.init?.body).toBe(JSON.stringify(request));
    expect(new Headers(calls[0]?.init?.headers).get('content-type')).toBe('application/json');
  });
});

describe('postRunFeedback (C19, #540)', () => {
  const RUN_ID = '33333333-3333-4333-8333-333333333333';

  it('POSTs the rating with the session token and reads a 204 as sent', async () => {
    const calls: Recorded[] = [];
    const fake = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: typeof input === 'string' ? input : 'not a path', init });
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    await expect(postRunFeedback(RUN_ID, SESSION.token, { rating: 'up' }, fake)).resolves.toEqual({
      kind: 'sent',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`/api/runs/${RUN_ID}/feedback`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe('{"rating":"up"}');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe(
      `Bearer ${SESSION.token}`,
    );
  });

  it('reads a refusal with its code, and an answer that is not JSON', async () => {
    const refused = answering(403, {
      error: { code: 'token_out_of_scope', message: 'Not this session.' },
    });
    await expect(
      postRunFeedback(RUN_ID, SESSION.token, { rating: 'down' }, refused.fetch),
    ).resolves.toEqual({
      kind: 'problem',
      status: 403,
      code: 'token_out_of_scope',
      message: 'Not this session.',
      retryAfterSeconds: null,
    });
    const html = answering(502, '<html>bad gateway</html>');
    await expect(
      postRunFeedback(RUN_ID, SESSION.token, { rating: 'down' }, html.fetch),
    ).resolves.toEqual({
      kind: 'failed',
      message: 'The feedback request failed with HTTP 502.',
    });
  });
});

describe('a baseUrl (#623)', () => {
  const RUN_ID = '33333333-3333-4333-8333-333333333333';

  it('joins paths as the SDK client does: the base’s path prefix kept, never a doubled slash', () => {
    expect(surfaceUrl(undefined, '/p/s/main/sessions')).toBe('/p/s/main/sessions');
    expect(surfaceUrl('https://agents.example.com', '/p/s/main/sessions')).toBe(
      'https://agents.example.com/p/s/main/sessions',
    );
    expect(surfaceUrl('https://shop.example.com/agents/', '/api/runs')).toBe(
      'https://shop.example.com/agents/api/runs',
    );
  });

  it('sends the bootstrap and the feedback there, with no cookie to another origin', async () => {
    const opened = answering(201, SESSION);
    await openSurfaceSession('main', opened.fetch, {}, 'https://agents.example.com');
    expect(opened.calls[0]?.url).toBe('https://agents.example.com/p/s/main/sessions');
    expect(opened.calls[0]?.init?.credentials).toBe('same-origin');
    const rated = answering(403, { error: { code: 'token_out_of_scope', message: 'No.' } });
    await postRunFeedback(
      RUN_ID,
      SESSION.token,
      { rating: 'up' },
      rated.fetch,
      'https://agents.example.com',
    );
    expect(rated.calls[0]?.url).toBe(`https://agents.example.com/api/runs/${RUN_ID}/feedback`);
  });
});
