import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiProblemSchema } from '@indx-workspace/contracts';
import {
  SurfaceSessionResponseSchema,
  type SurfaceSessionRequest,
} from '@indx-workspace/contracts/surfaces';

import { MIN_SESSION_SECRET_LENGTH } from '../../auth/session';
import { toResponse } from '../../rbac/http';
import {
  createSurfaceSession,
  preflightSurfaceSession,
  preflightVisitorRun,
  readSurfacePage,
  SESSION_BODY_MAX_BYTES,
  visitorRunResponseHeaders,
} from './handlers';
import { resetSurfaceLimits, SURFACE_RATE_LIMITS } from './limits';
import {
  clearSurfaceSessionsRuntime,
  configureSurfaceSessionsRuntime,
  type ResolvedSurface,
  type SurfaceSessionOpening,
} from './runtime';

const LOCAL_ENV = { AW_LOCAL_SURFACE_SESSIONS: '1', HOST: '127.0.0.1' } as const;
const SAME_ORIGIN = {
  host: '127.0.0.1:4310',
  origin: 'http://127.0.0.1:4310',
  'sec-fetch-site': 'same-origin',
} as const;
const TOKEN = `awt_live_${'a'.repeat(22)}_${'b'.repeat(43)}`;
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_AGENT_ID = '44444444-4444-4444-8444-444444444444';
const RESUME_KEY = 'k'.repeat(43);
const EXPIRES_AT = new Date('2026-10-02T11:00:00.000Z');
const FRAME_ANCESTORS = "frame-ancestors 'self'";

const RESOLVED: ResolvedSurface = {
  workspaceId: '33333333-3333-4333-8333-333333333333',
  agentId: AGENT_ID,
  agentName: 'Support triage',
  environment: 'local',
  versionId: '55555555-5555-4555-8555-555555555555',
  versionNumber: 2,
  promoted: false,
  surface: { name: 'main', agent: 'Support triage' },
};

interface FakeRuntimeCalls {
  readonly resolved: string[];
  readonly opened: ResolvedSurface[];
  readonly requests: SurfaceSessionRequest[];
}

/** Install a fake runtime that records every call, so a test can assert what was not called. */
function install(
  resolved: ResolvedSurface | null,
  opening: SurfaceSessionOpening = {
    kind: 'opened',
    sessionId: SESSION_ID,
    agentId: AGENT_ID,
    token: TOKEN,
    expiresAt: EXPIRES_AT,
    resumeKey: RESUME_KEY,
  },
): FakeRuntimeCalls {
  const calls: FakeRuntimeCalls = { resolved: [], opened: [], requests: [] };
  configureSurfaceSessionsRuntime({
    resolve: (name, mode) => {
      calls.resolved.push(mode === 'public' ? name : `${name} (${mode})`);
      return Promise.resolve(resolved);
    },
    open: (surface, options) => {
      calls.opened.push(surface);
      calls.requests.push(options);
      return Promise.resolve(opening);
    },
    checkModel: () => Promise.reject(new Error('the bootstrap never checks a model alone')),
    visitorSurface: () => Promise.reject(new Error('the bootstrap never looks a session up')),
    servedSurfaces: () => Promise.resolve(resolved === null ? [] : [resolved.surface]),
  });
  return calls;
}

function request(
  values: Readonly<Record<string, string>> = SAME_ORIGIN,
  body?: BodyInit,
  url = 'http://127.0.0.1:4310/p/s/main/sessions',
): Request {
  return new Request(url, {
    method: 'POST',
    headers: values,
    ...(body === undefined ? {} : { body }),
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } satisfies RequestInit & { duplex?: 'half' });
}

async function answer(
  name: string,
  input: Request = request(),
  env: Readonly<Record<string, string>> = LOCAL_ENV,
): Promise<{ status: number; body: unknown; response: Response }> {
  const response = toResponse(await createSurfaceSession(input, name, env));
  const body: unknown = await response.clone().json();
  return { status: response.status, body, response };
}

function codeOf(body: unknown): string {
  return ApiProblemSchema.parse(body).error.code;
}

afterEach(() => {
  clearSurfaceSessionsRuntime();
  resetSurfaceLimits();
});

describe('POST /p/s/<name>/sessions (ADR-0105 slice 1; S1-17, #455)', () => {
  it('opens a session and answers 201 with a contract body, no-store and frame-ancestors', async () => {
    const calls = install(RESOLVED);
    const { status, body, response } = await answer('main');

    expect(status).toBe(201);
    expect(SurfaceSessionResponseSchema.parse(body)).toEqual({
      token: TOKEN,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      expiresAt: EXPIRES_AT.toISOString(),
      resumeKey: RESUME_KEY,
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toBe(FRAME_ANCESTORS);
    expect(calls).toEqual({ resolved: ['main'], opened: [RESOLVED], requests: [{}] });
  });

  it.each([
    ['flag', {}, SAME_ORIGIN],
    ['listen-host', { AW_LOCAL_SURFACE_SESSIONS: '1', HOST: '0.0.0.0' }, SAME_ORIGIN],
    ['request-host', LOCAL_ENV, { ...SAME_ORIGIN, host: 'example.com' }],
    ['same-origin', LOCAL_ENV, { ...SAME_ORIGIN, origin: 'http://evil.example' }],
  ])(
    'answers 404 surface_sessions_unavailable when %s fails, and opens nothing',
    async (failed, env, values) => {
      const calls = install(RESOLVED);
      const { status, body, response } = await answer('main', request(values), env);

      expect(status).toBe(404);
      expect(ApiProblemSchema.parse(body).error).toMatchObject({
        code: 'surface_sessions_unavailable',
        details: [failed],
      });
      expect(response.headers.get('content-security-policy')).toBe(FRAME_ANCESTORS);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(calls).toEqual({ resolved: ['main'], opened: [], requests: [] });
    },
  );

  it('refuses a body with an unknown key with 400 invalid_body, naming the key', async () => {
    const calls = install(RESOLVED);
    const refused = await answer('main', request(SAME_ORIGIN, '{"ttlSeconds":60}'));
    expect(refused.status).toBe(400);
    expect(ApiProblemSchema.parse(refused.body).error.code).toBe('invalid_body');
    expect(ApiProblemSchema.parse(refused.body).error.details).toEqual([
      expect.stringContaining('ttlSeconds'),
    ]);
    expect(calls).toEqual({ resolved: [], opened: [], requests: [] });
  });

  it.each([
    ['no body', undefined],
    ['a blank body', ' \n\t\r'],
    ['an empty object', '{}'],
  ])('reads %s as no option and opens a session', async (_label, body) => {
    const calls = install(RESOLVED);
    const { status } = await answer('main', request(SAME_ORIGIN, body));
    expect(status).toBe(201);
    expect(calls.requests).toEqual([{}]);
  });

  it.each([
    ['non-JSON', 'resume=1'],
    ['an array', '[]'],
    ['a string', '"main"'],
    ['a non-breaking space', '\u00a0'],
    ['a short resume key', JSON.stringify({ resume: { sessionId: SESSION_ID, resumeKey: 'k' } })],
    ['a resume with no key', JSON.stringify({ resume: { sessionId: SESSION_ID } })],
  ])('refuses %s with 400 invalid_body and opens nothing', async (_label, body) => {
    const calls = install(RESOLVED);
    const refused = await answer('main', request(SAME_ORIGIN, body));
    expect(refused.status).toBe(400);
    expect(codeOf(refused.body)).toBe('invalid_body');
    expect(calls).toEqual({ resolved: [], opened: [], requests: [] });
  });

  it('passes a resume and an agent to the runtime, parsed', async () => {
    const calls = install(RESOLVED);
    const options = { resume: { sessionId: SESSION_ID, resumeKey: RESUME_KEY }, agent: 'Billing' };
    const { status } = await answer('main', request(SAME_ORIGIN, JSON.stringify(options)));
    expect(status).toBe(201);
    expect(calls.requests).toEqual([options]);
  });

  it('answers with the opened agent, and no resumeKey when a session resumed', async () => {
    install(RESOLVED, {
      kind: 'opened',
      sessionId: SESSION_ID,
      agentId: OTHER_AGENT_ID,
      token: TOKEN,
      expiresAt: EXPIRES_AT,
      resumeKey: null,
    });
    const { status, body } = await answer('main');
    expect(status).toBe(201);
    expect(SurfaceSessionResponseSchema.parse(body)).toEqual({
      token: TOKEN,
      sessionId: SESSION_ID,
      agentId: OTHER_AGENT_ID,
      expiresAt: EXPIRES_AT.toISOString(),
    });
  });

  it.each([
    ['agent-not-offered', 'surface_agent_not_offered'],
    ['not-resumable', 'surface_session_not_resumable'],
  ] as const)('answers %s with 404 %s, no-store', async (kind, code) => {
    install(RESOLVED, { kind });
    const { status, body, response } = await answer('main');
    expect(status).toBe(404);
    expect(codeOf(body)).toBe(code);
    expect(ApiProblemSchema.parse(body).error.details).toBeUndefined();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toBe(FRAME_ANCESTORS);
  });

  it('passes the conditions with the X-Forwarded-Host that Next.js adds to every request', async () => {
    install(RESOLVED);
    const forwarded = { ...SAME_ORIGIN, 'x-forwarded-host': SAME_ORIGIN.host };
    const { status } = await answer('main', request(forwarded));
    expect(status).toBe(201);
  });

  it('refuses a query string with 400 invalid_body, before anything is read', async () => {
    const calls = install(RESOLVED);
    const refused = await answer(
      'main',
      request(SAME_ORIGIN, undefined, 'http://127.0.0.1:4310/p/s/main/sessions?ttl=99999'),
    );
    expect(refused.status).toBe(400);
    expect(codeOf(refused.body)).toBe('invalid_body');
    expect(calls).toEqual({ resolved: [], opened: [], requests: [] });
  });

  it('refuses an oversized Content-Length without reading the body', async () => {
    install(RESOLVED);
    const declared = { ...SAME_ORIGIN, 'content-length': String(SESSION_BODY_MAX_BYTES + 1) };
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(SESSION_BODY_MAX_BYTES + 1).fill(0x20));
        controller.close();
      },
    });
    const refused = await answer('main', request(declared, stream));
    expect(refused.status).toBe(400);
    expect(codeOf(refused.body)).toBe('invalid_body');
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it('stops reading a streamed body at the first chunk past the empty-body limit', async () => {
    install(RESOLVED);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(SESSION_BODY_MAX_BYTES).fill(0x20));
      },
    });
    const refused = await answer('main', request(SAME_ORIGIN, stream));
    expect(refused.status).toBe(400);
    expect(codeOf(refused.body)).toBe('invalid_body');
    expect(pulled).toBeLessThan(10);
  });

  it.each(['Main', '-main', 'a'.repeat(65), 'main/x', ''])(
    'answers 404 surface_not_found for the name %j without resolving it',
    async (name) => {
      const calls = install(RESOLVED);
      const { status, body } = await answer(name);
      expect(status).toBe(404);
      expect(codeOf(body)).toBe('surface_not_found');
      expect(calls.resolved).toEqual([]);
    },
  );

  it('resolves the try page’s environment: local request in try mode and passes it on (#612)', async () => {
    const calls = install(RESOLVED);
    const { status } = await answer(
      'main',
      request(SAME_ORIGIN, JSON.stringify({ environment: 'local' })),
    );
    expect(status).toBe(201);
    expect(calls).toEqual({
      resolved: ['main (try)'],
      opened: [RESOLVED],
      requests: [{ environment: 'local' }],
    });
  });

  it('answers 503 surface_sessions_not_configured with no runtime', async () => {
    const { status, body, response } = await answer('main');
    expect(status).toBe(503);
    expect(codeOf(body)).toBe('surface_sessions_not_configured');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toBe(FRAME_ANCESTORS);
  });

  it('answers 404 surface_not_found for an unknown surface, and opens nothing', async () => {
    const calls = install(null);
    const { status, body } = await answer('other');
    expect(status).toBe(404);
    expect(codeOf(body)).toBe('surface_not_found');
    expect(calls).toEqual({ resolved: ['other'], opened: [], requests: [] });
  });

  it('answers 404 surface_not_found when the surface is gone by the time it is opened', async () => {
    install(RESOLVED, { kind: 'gone' });
    const { status, body } = await answer('main');
    expect(status).toBe(404);
    expect(codeOf(body)).toBe('surface_not_found');
  });

  it('answers 422 with the run-start code the preflight refused with', async () => {
    install(RESOLVED, {
      kind: 'refused',
      code: 'agent_runtime_profile_missing',
      message: 'agent "Support triage" has no runtime profile.',
    });
    const { status, body } = await answer('main');
    expect(status).toBe(422);
    expect(ApiProblemSchema.parse(body).error).toEqual({
      code: 'agent_runtime_profile_missing',
      message: 'agent "Support triage" has no runtime profile.',
    });
  });
});

describe('POST /p/s/<name>/sessions from an allowed origin (#622)', () => {
  const SHOP = 'https://shop.example.com';
  const LISTED: ResolvedSurface = {
    ...RESOLVED,
    surface: { ...RESOLVED.surface, allowedOrigins: [SHOP] },
  };
  const DEPLOYED = { host: 'aw.example.com', 'sec-fetch-site': 'cross-site' } as const;
  const deployed = (origin: string): Request =>
    request({ ...DEPLOYED, origin }, undefined, 'https://aw.example.com/p/s/main/sessions');

  it('opens a session for a listed origin and lets its page read the answer', async () => {
    const calls = install(LISTED);
    const { status, response } = await answer('main', deployed(SHOP), {});
    expect(status).toBe(201);
    expect(response.headers.get('access-control-allow-origin')).toBe(SHOP);
    expect(response.headers.get('vary')).toBe('origin');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(calls.opened).toEqual([LISTED]);
  });

  it('refuses another origin with 403 surface_origin_not_allowed, unreadable, opening nothing', async () => {
    const calls = install(LISTED);
    const { status, body, response } = await answer('main', deployed('https://evil.example'), {});
    expect(status).toBe(403);
    expect(codeOf(body)).toBe('surface_origin_not_allowed');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(calls.opened).toEqual([]);
  });

  it('does not serve the try page’s local draft to an allowed origin: 404 surface_not_found (#612)', async () => {
    const calls = install(LISTED);
    const { status, body, response } = await answer(
      'main',
      request(
        { ...DEPLOYED, origin: SHOP },
        JSON.stringify({ environment: 'local' }),
        'https://aw.example.com/p/s/main/sessions',
      ),
      {},
    );
    expect(status).toBe(404);
    expect(codeOf(body)).toBe('surface_not_found');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(calls).toMatchObject({ resolved: ['main (try)'], opened: [] });
  });

  it('refuses a surface with no list off loopback as before, 404 surface_sessions_unavailable', async () => {
    const calls = install(RESOLVED);
    const { status, body } = await answer('main', deployed(SHOP), {});
    expect(status).toBe(404);
    expect(codeOf(body)).toBe('surface_sessions_unavailable');
    expect(calls.opened).toEqual([]);
  });

  it('answers 429 surface_rate_limited with Retry-After to the 11th session of a client in a minute', async () => {
    const calls = install(LISTED);
    const proxied = {
      AW_TRUSTED_PROXY_HOPS: '1',
      SESSION_SECRET: 'k'.repeat(MIN_SESSION_SECRET_LENGTH),
    };
    const from = (address: string): Request =>
      request(
        { ...DEPLOYED, origin: SHOP, 'x-forwarded-for': address },
        undefined,
        'https://aw.example.com/p/s/main/sessions',
      );
    for (let opened = 0; opened < SURFACE_RATE_LIMITS.sessionsPerClient; opened += 1) {
      expect((await answer('main', from('203.0.113.7'), proxied)).status).toBe(201);
    }
    const { status, body, response } = await answer('main', from('203.0.113.7'), proxied);
    expect(status).toBe(429);
    expect(codeOf(body)).toBe('surface_rate_limited');
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(response.headers.get('access-control-allow-origin')).toBe(SHOP);
    expect(calls.opened).toHaveLength(SURFACE_RATE_LIMITS.sessionsPerClient);
    expect((await answer('main', from('203.0.113.8'), proxied)).status).toBe(201);
  });
});

describe('an origin only the local draft lists, while production serves visitors (#733)', () => {
  const SITE = 'http://127.0.0.1:5173';
  const PRODUCTION: ResolvedSurface = { ...RESOLVED, environment: 'production', promoted: true };
  const DRAFT: ResolvedSurface = {
    ...RESOLVED,
    versionNumber: 3,
    promoted: true,
    surface: { ...RESOLVED.surface, allowedOrigins: [SITE] },
  };
  const FROM_SITE = { host: '127.0.0.1:3200', origin: SITE, 'sec-fetch-site': 'same-site' };
  const PREFLIGHT = { ...FROM_SITE, 'access-control-request-method': 'POST' };

  /** A runtime whose public lookup answers `production` and whose try lookup answers `draft`. */
  function installVersions(production: ResolvedSurface | null, draft: ResolvedSurface): void {
    configureSurfaceSessionsRuntime({
      resolve: (_name, mode) => Promise.resolve(mode === 'public' ? production : draft),
      open: () => Promise.reject(new Error('a refused origin never opens a session')),
      checkModel: () => Promise.reject(new Error('the bootstrap never checks a model alone')),
      visitorSurface: () => Promise.reject(new Error('the bootstrap never looks a session up')),
      servedSurfaces: () => Promise.resolve(production === null ? [] : [production.surface]),
    });
  }

  it('refuses with a readable 403 that names production and `aw promote`', async () => {
    installVersions(PRODUCTION, DRAFT);
    const { status, body, response } = await answer('main', request(FROM_SITE));
    expect(status).toBe(403);
    const { error } = ApiProblemSchema.parse(body);
    expect(error.code).toBe('surface_origin_not_allowed');
    expect(error.details).toEqual(['promotion-pending']);
    expect(error.message).toContain('production version');
    expect(error.message).toContain('aw promote');
    expect(response.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(await preflightSurfaceSession('main', new Headers(PREFLIGHT), LOCAL_ENV)).toMatchObject({
      'access-control-allow-origin': SITE,
    });
  });

  it('does not look the draft up for a request without an Origin', async () => {
    const modes: string[] = [];
    configureSurfaceSessionsRuntime({
      resolve: (_name, mode) => {
        modes.push(mode);
        return Promise.resolve(mode === 'public' ? PRODUCTION : DRAFT);
      },
      open: () => Promise.reject(new Error('a refused origin never opens a session')),
      checkModel: () => Promise.reject(new Error('the bootstrap never checks a model alone')),
      visitorSurface: () => Promise.reject(new Error('the bootstrap never looks a session up')),
      servedSurfaces: () => Promise.resolve([PRODUCTION.surface]),
    });
    const { host } = FROM_SITE;
    expect((await answer('main', request({ host }))).status).toBe(404);
    expect(await preflightSurfaceSession('main', new Headers({ host }), LOCAL_ENV)).toEqual({
      'cache-control': 'no-store',
      vary: 'origin',
    });
    expect(modes).toEqual(['public', 'public']);
  });

  it('gives the same hint when the production version carries no such surface', async () => {
    installVersions(null, DRAFT);
    const { status, body } = await answer('main', request(FROM_SITE));
    expect(status).toBe(403);
    expect(ApiProblemSchema.parse(body).error.details).toEqual(['promotion-pending']);
  });

  it('grants nothing to an origin no version lists, nor before the agent is promoted', async () => {
    installVersions(PRODUCTION, DRAFT);
    const other = { ...FROM_SITE, origin: 'http://127.0.0.1:9999' };
    const refused = await answer('main', request(other));
    expect(refused.status).toBe(404);
    expect(refused.response.headers.get('access-control-allow-origin')).toBeNull();
    expect(
      await preflightSurfaceSession('main', new Headers({ ...PREFLIGHT, ...other }), LOCAL_ENV),
    ).toEqual({ 'cache-control': 'no-store', vary: 'origin' });

    installVersions({ ...PRODUCTION, promoted: false }, { ...DRAFT, promoted: false });
    const { body } = await answer('main', request(FROM_SITE));
    expect(ApiProblemSchema.parse(body).error.details).toEqual(['same-origin']);
  });
});

describe('the local draft’s default origins under `aw dev` (#699, composed with #733)', () => {
  const APP = 'http://localhost:5173';
  const FROM_APP = { host: '127.0.0.1:3200', origin: APP, 'sec-fetch-site': 'same-site' };

  it('opens a session of the unpromoted local draft from a loopback app, with CORS', async () => {
    const calls = install(RESOLVED);
    const { status, response } = await answer('main', request(FROM_APP));
    expect(status).toBe(201);
    expect(response.headers.get('access-control-allow-origin')).toBe(APP);
    expect(calls.opened).toEqual([RESOLVED]);
    expect(
      await preflightSurfaceSession(
        'main',
        new Headers({ ...FROM_APP, 'access-control-request-method': 'POST' }),
        LOCAL_ENV,
      ),
    ).toMatchObject({ 'access-control-allow-origin': APP });
  });

  it('lets the run routes answer CORS only for a surface served from the local draft', async () => {
    const run = new Headers({ ...FROM_APP, 'access-control-request-method': 'POST' });
    configureSurfaceSessionsRuntime({
      resolve: () => Promise.resolve(RESOLVED),
      open: () => Promise.reject(new Error('the run routes never open a session')),
      checkModel: () => Promise.reject(new Error('the run routes never check a model')),
      visitorSurface: () => Promise.reject(new Error('the preflight never looks a session up')),
      servedSurfaces: () => Promise.resolve([{ ...RESOLVED.surface, servedFrom: 'local' }]),
    });
    expect(await preflightVisitorRun('POST', run, LOCAL_ENV)).toMatchObject({
      'access-control-allow-origin': APP,
    });
    configureSurfaceSessionsRuntime({
      resolve: () => Promise.resolve(RESOLVED),
      open: () => Promise.reject(new Error('the run routes never open a session')),
      checkModel: () => Promise.reject(new Error('the run routes never check a model')),
      visitorSurface: () => Promise.reject(new Error('the preflight never looks a session up')),
      servedSurfaces: () => Promise.resolve([{ ...RESOLVED.surface, servedFrom: 'production' }]),
    });
    expect(await preflightVisitorRun('POST', run, LOCAL_ENV)).toEqual({
      'cache-control': 'no-store',
      vary: 'origin',
    });
  });

  it('refuses the same app once a production version without origins serves visitors', async () => {
    const calls = install({ ...RESOLVED, environment: 'production', promoted: true });
    const { status, body, response } = await answer('main', request(FROM_APP));
    expect(status).toBe(404);
    expect(ApiProblemSchema.parse(body).error.details).toEqual(['same-origin']);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(calls.opened).toEqual([]);
  });
});

describe('CORS of the run routes a visitor token may call (#680)', () => {
  const SHOP = 'https://shop.example.com';
  const LISTED: ResolvedSurface = {
    ...RESOLVED,
    surface: { ...RESOLVED.surface, allowedOrigins: [SHOP] },
  };
  const from = (origin: string | null, method = 'GET'): Headers =>
    new Headers({
      host: 'aw.example.com',
      'sec-fetch-site': 'cross-site',
      'access-control-request-method': method,
      ...(origin === null ? {} : { origin }),
    });

  it('grants a listed origin the route’s own method, with no credentials', async () => {
    install(LISTED);
    const preflight = await preflightVisitorRun('POST', from(SHOP, 'POST'), {});
    expect(preflight).toMatchObject({
      'access-control-allow-origin': SHOP,
      'access-control-allow-methods': 'POST',
      vary: 'origin',
    });
    expect(preflight['access-control-allow-headers']).toContain('authorization');
    expect(preflight['access-control-allow-headers']).toContain('last-event-id');
    expect(preflight).not.toHaveProperty('access-control-allow-credentials');
    const response = await visitorRunResponseHeaders(from(SHOP), {});
    expect(response['access-control-allow-origin']).toBe(SHOP);
    expect(response['access-control-expose-headers']).toContain('retry-after');
    expect(response).not.toHaveProperty('access-control-allow-credentials');
  });

  it('grants nothing to another method, origin, a null or missing one, or a same-origin page', async () => {
    install(LISTED);
    for (const headers of [
      from(SHOP, 'DELETE'),
      from('https://evil.example'),
      from('null'),
      from(null),
      new Headers({ host: 'aw.example.com', origin: 'https://aw.example.com' }),
    ]) {
      const preflight = await preflightVisitorRun('GET', headers, {});
      expect(preflight).toEqual({ 'cache-control': 'no-store', vary: 'origin' });
      if (headers.get('access-control-request-method') !== 'DELETE') {
        expect(await visitorRunResponseHeaders(headers, {})).toEqual({ vary: 'origin' });
      }
    }
  });

  it('grants nothing when no served surface lists origins, or none is installed', async () => {
    install(RESOLVED);
    expect(await visitorRunResponseHeaders(from(SHOP), {})).toEqual({ vary: 'origin' });
    clearSurfaceSessionsRuntime();
    expect(await visitorRunResponseHeaders(from(SHOP), {})).toEqual({ vary: 'origin' });
  });

  it('fails closed when the served surfaces cannot be read', async () => {
    configureSurfaceSessionsRuntime({
      resolve: () => Promise.resolve(null),
      open: () => Promise.reject(new Error('never opened')),
      visitorSurface: () => Promise.resolve(null),
      servedSurfaces: () => Promise.reject(new Error('the database is down')),
      checkModel: () => Promise.reject(new Error('never checked')),
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await visitorRunResponseHeaders(from(SHOP), {})).toEqual({ vary: 'origin' });
      expect(logged).toHaveBeenCalledOnce();
    } finally {
      logged.mockRestore();
    }
  });

  it('grants the session bootstrap preflight through the same check', async () => {
    install(LISTED);
    expect(await preflightSurfaceSession('main', from(SHOP, 'POST'), {})).toMatchObject({
      'access-control-allow-origin': SHOP,
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'content-type',
    });
    expect(await preflightSurfaceSession('main', from('https://evil.example'), {})).toEqual({
      'cache-control': 'no-store',
      vary: 'origin',
    });
  });
});

describe('readSurfacePage (GET /p/s/<name>)', () => {
  const pageHeaders = new Headers({ host: '127.0.0.1:4310' });

  it('renders the surface and its agent when conditions 1-3 hold, and opens nothing', async () => {
    const calls = install(RESOLVED);
    await expect(readSurfacePage('main', pageHeaders, LOCAL_ENV)).resolves.toEqual({
      branch: 'loopback',
      surfaceName: 'main',
      agentName: 'Support triage',
      surface: RESOLVED.surface,
      promoted: false,
    });
    expect(calls.opened).toEqual([]);
  });

  it('reads the try page in try mode, on loopback only, with whether the agent is promoted (#612)', async () => {
    const calls = install({ ...RESOLVED, promoted: true });
    const page = await readSurfacePage('main', pageHeaders, LOCAL_ENV, 'try');
    expect(page?.promoted).toBe(true);
    expect(calls.resolved).toEqual(['main (try)']);

    install({
      ...RESOLVED,
      surface: { ...RESOLVED.surface, allowedOrigins: ['https://a.example'] },
    });
    await expect(
      readSurfacePage('main', new Headers({ host: 'aw.example.com' }), {}, 'try'),
    ).resolves.toBeNull();
  });

  it('renders behind the X-Forwarded-Host that Next.js sets, under a container HOSTNAME', async () => {
    install(RESOLVED);
    const nextHeaders = new Headers({
      host: '127.0.0.1:4310',
      'x-forwarded-host': '127.0.0.1:4310',
      'x-forwarded-port': '4310',
      'x-forwarded-proto': 'http',
      'x-forwarded-for': '127.0.0.1',
    });
    const env = { ...LOCAL_ENV, AW_DEPLOYMENT_POSTURE: 'local', HOSTNAME: '3f2a9c1b7d4e' };
    await expect(readSurfacePage('main', nextHeaders, env)).resolves.toEqual({
      branch: 'loopback',
      surfaceName: 'main',
      agentName: 'Support triage',
      surface: RESOLVED.surface,
      promoted: false,
    });
  });

  it('passes the parsed definition through, so the page and the loader read its look (S1-18)', async () => {
    const surface = {
      name: 'main',
      agent: 'Support triage',
      title: 'Help centre',
      theme: { colour: '#0a7f5a', radius: 12, locale: 'ja' },
      layout: 'side',
      parts: { greeting: 'Hello', toolTrace: 'collapsed' },
    } as const;
    install({ ...RESOLVED, surface });
    const page = await readSurfacePage('main', pageHeaders, LOCAL_ENV);
    expect(page?.surface).toEqual(surface);
  });

  it('is not found with no runtime, a failed condition, a bad name or an unknown surface', async () => {
    await expect(readSurfacePage('main', pageHeaders, LOCAL_ENV)).resolves.toBeNull();
    const calls = install(null);
    await expect(readSurfacePage('main', pageHeaders, {})).resolves.toBeNull();
    await expect(
      readSurfacePage('main', new Headers({ host: 'example.com' }), LOCAL_ENV),
    ).resolves.toBeNull();
    await expect(readSurfacePage('Main', pageHeaders, LOCAL_ENV)).resolves.toBeNull();
    await expect(readSurfacePage('main', pageHeaders, LOCAL_ENV)).resolves.toBeNull();
    expect(calls.resolved).toEqual(['main', 'main', 'main']);
  });

  it('renders a surface with allowedOrigins off loopback, on the allowed-origin branch (#622)', async () => {
    install({
      ...RESOLVED,
      surface: { ...RESOLVED.surface, allowedOrigins: ['https://a.example'] },
    });
    const page = await readSurfacePage('main', new Headers({ host: 'aw.example.com' }), {});
    expect(page?.branch).toBe('allowed-origin');
  });
});
