import type { SurfaceRuntimeInstaller } from './handlers.fixture.test-support';
import { describe, expect, it } from 'vitest';
import { ApiProblemSchema } from '@indx-workspace/contracts';
import { SurfaceSessionResponseSchema } from '@indx-workspace/contracts/surfaces';
import { SESSION_BODY_MAX_BYTES } from './handlers';
import { installTestDomains } from '../../application-context-fixtures';
import {
  LOCAL_ENV,
  SAME_ORIGIN,
  TOKEN,
  SESSION_ID,
  AGENT_ID,
  OTHER_AGENT_ID,
  RESUME_KEY,
  EXPIRES_AT,
  FRAME_ANCESTORS,
  RESOLVED,
  request,
  answer,
  codeOf,
} from './handlers.fixture.test-support';
function registerSurfaceOpeningTests(install: SurfaceRuntimeInstaller) {
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
}
function registerSurfaceRequestOptionsTests(install: SurfaceRuntimeInstaller) {
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
}
function registerSurfaceRequestBoundariesTests(install: SurfaceRuntimeInstaller) {
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
}
function registerSurfaceResolutionTests(install: SurfaceRuntimeInstaller) {
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
  it('answers the same 503 while the surfaces are disabled (no run runtime)', async () => {
    installTestDomains({ surfaces: { kind: 'disabled' } });
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
}
export function registerSurfaceSessionTests(install: SurfaceRuntimeInstaller) {
  describe('POST /p/s/<name>/sessions (ADR-0105 slice 1; S1-17, #455)', () => {
    registerSurfaceOpeningTests(install);
    registerSurfaceRequestOptionsTests(install);
    registerSurfaceRequestBoundariesTests(install);
    registerSurfaceResolutionTests(install);
  });
}
