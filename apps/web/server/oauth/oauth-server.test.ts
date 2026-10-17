/**
 * The OAuth 2.1 server for endpoint clients (ADR-0134 part 3), end to end over the real handlers:
 * discovery, consent, the three grants, revocation, the rate limits, tenant isolation and the
 * audit trail. The database seam is an in-memory `OAuthRuntime`; the single-use and family
 * semantics of the real token repository are covered against PostgreSQL in
 * `packages/core/src/db/repositories/oauth-tokens.postgres.test.ts`.
 */
import type {
  IssueOAuthTokenInput,
  OAuthConsumeOutcome,
  OAuthTokenRepository,
} from '@agent-workspace/core/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as AUTHORIZE_GET, POST as AUTHORIZE_POST } from '../../app/oauth/authorize/route';
import { POST as REVOKE } from '../../app/oauth/revoke/route';
import { POST as TOKEN } from '../../app/oauth/token/route';
import { GET as AS_METADATA } from '../../app/.well-known/oauth-authorization-server/route';
import { GET as MCP_METADATA } from '../../app/.well-known/oauth-protected-resource/mcp/projects/[name]/route';
import { GET as A2A_METADATA } from '../../app/.well-known/oauth-protected-resource/api/a2a/agents/[agentName]/route';
import { conferredBy } from '../rbac/conferral';
import { Principal } from '../rbac/principal';
import { configureRbacRuntime, currentRbacRuntime } from '../rbac/runtime';
import {
  callerHeaders,
  installRbacHarness,
  TEST_WORKSPACE_ID,
  type RbacHarness,
} from '../rbac/testing';
import { admitOAuthAddress, OAUTH_RATE_LIMITS, resetOAuthLimits } from './limits';
import {
  clearOAuthRuntime,
  configureOAuthRuntime,
  type OAuthAuditEvent,
  type OAuthClient,
} from './runtime';
import {
  installToolEndpoint,
  resetToolEndpoint,
  type ToolEndpointEnvironment,
} from '../tool-endpoint/env';
import { mintClientSecret, parseOAuthToken } from './tokens';

const ORIGIN = 'https://aw.example';
const REDIRECT = 'https://app.example/callback';
const MCP_RESOURCE = `${ORIGIN}/mcp/projects/docs`;
const A2A_RESOURCE = `${ORIGIN}/api/a2a/agents/helper`;
const OTHER_WORKSPACE = 'some-other-workspace';
const PROXY_TEST_SECRET = 'a-secure-test-secret-with-at-least-32-characters';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const ownerCaller = { email: 'owner@example.com' };
const viewerCaller = { email: 'viewer@example.com' };

interface Row extends IssueOAuthTokenInput {
  usedAt: Date | null;
  revokedAt: Date | null;
}

/** The semantics of `oauth-tokens.ts` over an array: single use, family revocation, client binding. */
function fakeTokens(rows: Row[]): OAuthTokenRepository {
  const live = (row: Row): boolean =>
    row.revokedAt === null && row.expiresAt.getTime() > Date.now();
  return {
    issue: (input) => {
      rows.push({ ...input, usedAt: null, revokedAt: null });
      return Promise.resolve();
    },
    consume: (kind, tokenHash, clientId): Promise<OAuthConsumeOutcome> => {
      const row = rows.find(
        (r) => r.kind === kind && r.tokenHash === tokenHash && r.clientId === clientId,
      );
      if (row === undefined || !live(row)) return Promise.resolve({ kind: 'invalid' });
      if (row.usedAt !== null) {
        return Promise.resolve({
          kind: 'reused',
          familyId: row.familyId,
          subjectPrincipalId: row.subjectPrincipalId,
        });
      }
      row.usedAt = new Date();
      return Promise.resolve({
        kind: 'consumed',
        token: {
          id: row.id,
          clientId: row.clientId,
          kind: row.kind,
          subjectPrincipalId: row.subjectPrincipalId,
          resource: row.resource,
          familyId: row.familyId,
          codeChallenge: row.codeChallenge ?? null,
          redirectUri: row.redirectUri ?? null,
        },
      });
    },
    revokeFamily: (familyId) => {
      const open = rows.filter((r) => r.familyId === familyId && r.revokedAt === null);
      for (const row of open) row.revokedAt = new Date();
      return Promise.resolve(open.length);
    },
    revoke: (tokenHash, clientId) => {
      const row = rows.find(
        (r) =>
          r.tokenHash === tokenHash &&
          r.clientId === clientId &&
          (r.kind === 'access' || r.kind === 'refresh') &&
          r.revokedAt === null,
      );
      if (row === undefined) return Promise.resolve(null);
      const family = row.kind === 'refresh';
      for (const r of rows) {
        if (family ? r.familyId === row.familyId : r === row) r.revokedAt ??= new Date();
      }
      return Promise.resolve({
        kind: row.kind,
        familyId: row.familyId,
        subjectPrincipalId: row.subjectPrincipalId,
      });
    },
  };
}

let harness: RbacHarness;
let ownerId: string;
let viewerId: string;
let rows: Row[];
let audits: { workspaceId: string; actor: string; event: OAuthAuditEvent }[];
let clients: Map<string, OAuthClient>;
let cannotRun: Set<string>;
let agentGone: boolean;
let secret: string;
let mcp: OAuthClient;
let a2a: OAuthClient;
let foreign: OAuthClient;
/** Every body any handler returned, for the plaintext scan. */
let bodies: string[];

function client(over: Partial<OAuthClient> & Pick<OAuthClient, 'id' | 'name'>): OAuthClient {
  return {
    workspaceId: TEST_WORKSPACE_ID,
    kind: 'mcp-project',
    actsForPrincipalId: ownerId,
    clientSecretHash: null,
    redirectUris: [REDIRECT],
    agentIds: ['agent-1'],
    resourcePath: '/mcp/projects/docs',
    ...over,
  };
}

beforeEach(async () => {
  vi.stubEnv('AW_PUBLIC_URL', ORIGIN);
  resetOAuthLimits();
  harness = installRbacHarness([
    { email: ownerCaller.email, name: 'Owner', workspaceId: TEST_WORKSPACE_ID, role: 'owner' },
    { email: viewerCaller.email, name: 'Viewer', workspaceId: TEST_WORKSPACE_ID, role: 'viewer' },
  ]);
  const members = await harness.directory.forWorkspace(TEST_WORKSPACE_ID).listMemberships();
  const principalOf = (email: string): string =>
    members.find((m) => m.email === email)?.principalId ?? 'missing';
  ownerId = principalOf(ownerCaller.email);
  viewerId = principalOf(viewerCaller.email);

  const minted = await mintClientSecret();
  secret = minted.presented;
  mcp = client({
    id: crypto.randomUUID(),
    name: 'Docs <b>bot</b>',
    clientSecretHash: minted.secretHash,
  });
  a2a = client({
    id: crypto.randomUUID(),
    name: 'Helper',
    kind: 'a2a-agent',
    resourcePath: '/api/a2a/agents/helper',
  });
  foreign = client({
    id: crypto.randomUUID(),
    name: 'Foreign',
    workspaceId: OTHER_WORKSPACE,
    clientSecretHash: minted.secretHash,
  });
  clients = new Map([mcp, a2a, foreign].map((c) => [c.id, c]));
  rows = [];
  audits = [];
  cannotRun = new Set();
  agentGone = false;
  bodies = [];
  const repo = fakeTokens(rows);
  configureOAuthRuntime({
    findClient: (id) => Promise.resolve(clients.get(id) ?? null),
    canRunAll: (principal: Principal) => Promise.resolve(!cannotRun.has(principal.principalId)),
    agentNames: (_workspaceId, agentIds) =>
      Promise.resolve(agentGone ? null : agentIds.map((id) => `<i>${id}</i>`)),
    tokens: () => Promise.resolve(repo),
    audit: (workspaceId, actor, event) => {
      audits.push({ workspaceId, actor, event });
      return Promise.resolve();
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  clearOAuthRuntime();
  resetToolEndpoint();
  harness.teardown();
});

async function send(request: Request, handler: (r: Request) => Response | Promise<Response>) {
  const response = await handler(request);
  const text = await response.text();
  bodies.push(text);
  return { response, text, json: () => JSON.parse(text) as Record<string, unknown> };
}

const urlencoded = (params: Record<string, string>): string =>
  new URLSearchParams(params).toString();

function tokenRequest(
  params: Record<string, string>,
  headers: Record<string, string> = {},
  path = '/oauth/token',
): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: urlencoded(params),
  });
}

const basic = (id: string, pass: string): Record<string, string> => ({
  authorization: `Basic ${btoa(`${id}:${pass}`)}`,
});

const authorizeParams = (over: Record<string, string> = {}): Record<string, string> => ({
  response_type: 'code',
  client_id: a2a.id,
  redirect_uri: REDIRECT,
  code_challenge: CHALLENGE,
  code_challenge_method: 'S256',
  state: 'xyz',
  ...over,
});

const authorizeGet = (
  params: Record<string, string>,
  caller: typeof ownerCaller | null = ownerCaller,
) =>
  send(
    new Request(`${ORIGIN}/oauth/authorize?${urlencoded(params)}`, {
      headers: callerHeaders(caller),
    }),
    AUTHORIZE_GET,
  );

function authorizePost(
  params: Record<string, string>,
  headers: Record<string, string> = { origin: ORIGIN, ...callerHeaders(ownerCaller) },
) {
  return send(
    new Request(`${ORIGIN}/oauth/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: urlencoded(params),
    }),
    AUTHORIZE_POST,
  );
}

/** Walk consent for `a2a` and return the code. */
async function approvedCode(over: Record<string, string> = {}): Promise<string> {
  const { response } = await authorizePost({ ...authorizeParams(over), decision: 'approve' });
  expect(response.status).toBe(303);
  const code = new URL(response.headers.get('location') ?? '').searchParams.get('code');
  if (code === null) throw new Error('no code');
  return code;
}

const codeGrant = (code: string, over: Record<string, string> = {}): Record<string, string> => ({
  grant_type: 'authorization_code',
  client_id: a2a.id,
  code,
  redirect_uri: REDIRECT,
  code_verifier: VERIFIER,
  ...over,
});

async function issueTokens(): Promise<{ access: string; refresh: string }> {
  const out = await send(tokenRequest(codeGrant(await approvedCode())), TOKEN);
  expect(out.response.status).toBe(200);
  const body = out.json();
  return { access: String(body['access_token']), refresh: String(body['refresh_token']) };
}

describe('discovery documents', () => {
  it('serves RFC 8414 metadata that offers PKCE S256 only', async () => {
    const out = await send(
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
      AS_METADATA,
    );
    expect(out.response.status).toBe(200);
    expect(out.response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(out.json()).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      revocation_endpoint: `${ORIGIN}/oauth/revoke`,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'client_credentials', 'refresh_token'],
      authorization_response_iss_parameter_supported: true,
    });
  });

  it('serves RFC 9728 metadata for both resource kinds without touching the database', async () => {
    configureOAuthRuntime({
      findClient: () => Promise.reject(new Error('no database')),
      canRunAll: () => Promise.reject(new Error('no database')),
      agentNames: () => Promise.reject(new Error('no database')),
      tokens: () => Promise.reject(new Error('no database')),
      audit: () => Promise.reject(new Error('no database')),
    });
    const mcpOut = await send(
      new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp/projects/docs`),
      MCP_METADATA,
    );
    expect(mcpOut.json()).toMatchObject({
      resource: MCP_RESOURCE,
      authorization_servers: [ORIGIN],
    });
    const a2aOut = await send(
      new Request(`${ORIGIN}/.well-known/oauth-protected-resource/api/a2a/agents/helper`),
      A2A_METADATA,
    );
    expect(a2aOut.json()).toMatchObject({
      resource: A2A_RESOURCE,
      authorization_servers: [ORIGIN],
    });
  });

  it('answers 404 for a path that is not a resource', async () => {
    const out = await send(
      new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp/projects/a/b`),
      MCP_METADATA,
    );
    expect(out.response.status).toBe(404);
    expect(out.json()).toMatchObject({ error: 'invalid_target' });
  });

  it('answers 404 oauth_not_configured when AW_PUBLIC_URL is unset', async () => {
    vi.stubEnv('AW_PUBLIC_URL', '');
    const meta = await send(
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
      AS_METADATA,
    );
    expect(meta.response.status).toBe(404);
    expect(meta.json()).toMatchObject({ error: 'oauth_not_configured' });
    const tok = await send(tokenRequest({ grant_type: 'client_credentials' }), TOKEN);
    expect(tok.response.status).toBe(404);
    const auth = await authorizeGet(authorizeParams());
    expect(auth.response.status).toBe(404);
  });
});

describe('GET /oauth/authorize', () => {
  it('sends a signed-out visitor to /signin with a way back', async () => {
    const out = await authorizeGet(authorizeParams(), null);
    expect(out.response.status).toBe(302);
    const location = out.response.headers.get('location') ?? '';
    expect(location.startsWith('/signin?next=')).toBe(true);
    expect(decodeURIComponent(location.slice('/signin?next='.length))).toContain(
      '/oauth/authorize?',
    );
  });

  it('refuses an API key: only a browser session consents', async () => {
    const created = await harness.directory.forWorkspace(TEST_WORKSPACE_ID).createApiKey({
      name: 'k',
      role: conferredBy('owner', 'owner', 'test'),
      expiresAt: null,
    });
    if (created.kind !== 'created') throw new Error(created.kind);
    const out = await send(
      new Request(`${ORIGIN}/oauth/authorize?${urlencoded(authorizeParams())}`, {
        headers: { authorization: `Bearer ${created.presented}` },
      }),
      AUTHORIZE_GET,
    );
    expect(out.response.status).toBe(403);
    expect(out.json()).toMatchObject({ error: 'access_denied' });
  });

  it.each([
    ['a browser token', 'browser-token'],
    ['a user token', 'user-token'],
  ] as const)('refuses %s: only a browser session consents', async (_name, via) => {
    const rbac = currentRbacRuntime();
    if (rbac === null) throw new Error('no rbac runtime');
    const session = await rbac.identify(
      new Request(`${ORIGIN}/`, { headers: callerHeaders(ownerCaller) }),
    );
    if (session === null) throw new Error('no session');
    const principal =
      via === 'browser-token'
        ? Principal.fromBrowserToken(session, { kind: 'session', id: 'session-1' })
        : Principal.fromUserToken(session.workspaceId, ownerCaller.email, session.role, {
            principalId: session.principalId,
            userId: session.userId ?? 'user-1',
            label: session.label,
          });
    expect(principal.via).toBe(via);
    configureRbacRuntime({ ...rbac, identify: () => Promise.resolve(principal) });

    const get = await authorizeGet(authorizeParams());
    expect(get.response.status).toBe(403);
    expect(get.json()).toMatchObject({ error: 'access_denied' });
    const post = await authorizePost({ ...authorizeParams(), decision: 'approve' });
    expect(post.response.status).toBe(403);
    expect(post.response.headers.get('location')).toBeNull();
    expect(rows).toEqual([]);
  });

  it('shows an error page, and never redirects, for a client of another workspace', async () => {
    const out = await authorizeGet(authorizeParams({ client_id: foreign.id }));
    expect(out.response.status).toBe(400);
    expect(out.response.headers.get('location')).toBeNull();
  });

  it('shows the same page for an unknown client', async () => {
    const out = await authorizeGet(authorizeParams({ client_id: crypto.randomUUID() }));
    expect(out.response.status).toBe(400);
    expect(out.response.headers.get('location')).toBeNull();
  });

  it.each([
    ['an unregistered address', 'https://evil.example/callback'],
    ['a prefix of a registered one', 'https://app.example/call'],
    ['a registered one with a suffix', `${REDIRECT}/x`],
    ['a registered one with a query', `${REDIRECT}?a=1`],
  ])(
    'requires an exact redirect_uri (%s) and shows a page instead of redirecting',
    async (_n, uri) => {
      const out = await authorizeGet(authorizeParams({ redirect_uri: uri }));
      expect(out.response.status).toBe(400);
      expect(out.response.headers.get('location')).toBeNull();
    },
  );

  it.each<[string, Record<string, string>]>([
    ['plain PKCE', { code_challenge_method: 'plain' }],
    ['no code_challenge_method', { code_challenge_method: '' }],
    ['a malformed challenge', { code_challenge: 'short' }],
  ])('redirects invalid_request for %s', async (_n, over) => {
    const params = authorizeParams(over);
    if (over['code_challenge_method'] === '') delete params['code_challenge_method'];
    const out = await authorizeGet(params);
    expect(out.response.status).toBe(302);
    const location = new URL(out.response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('state')).toBe('xyz');
    expect(location.searchParams.get('iss')).toBe(ORIGIN);
  });

  it('refuses a missing code_challenge', async () => {
    const params = authorizeParams();
    delete params['code_challenge'];
    const out = await authorizeGet(params);
    expect(new URL(out.response.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'invalid_request',
    );
  });

  it('refuses another response_type and another scope', async () => {
    const type = await authorizeGet(authorizeParams({ response_type: 'token' }));
    expect(new URL(type.response.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'unsupported_response_type',
    );
    const scope = await authorizeGet(authorizeParams({ scope: 'admin' }));
    expect(new URL(scope.response.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'invalid_scope',
    );
  });

  it('binds the grant to the resource: a different resource is invalid_target', async () => {
    const out = await authorizeGet(authorizeParams({ resource: MCP_RESOURCE }));
    expect(new URL(out.response.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'invalid_target',
    );
  });

  it('refuses a member who cannot run every agent the client reaches', async () => {
    cannotRun.add(ownerId);
    const out = await authorizeGet(authorizeParams());
    expect(new URL(out.response.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'access_denied',
    );
  });

  it('refuses a client whose agent is gone (no resource)', async () => {
    clients.set(a2a.id, { ...a2a, resourcePath: null });
    const out = await authorizeGet(authorizeParams());
    expect(new URL(out.response.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'invalid_target',
    );
  });

  it('renders the consent page with the client name escaped and framing refused', async () => {
    const out = await authorizeGet(authorizeParams({ client_id: mcp.id, resource: MCP_RESOURCE }));
    expect(out.response.status).toBe(200);
    expect(out.text).toContain('Docs &#60;b&#62;bot&#60;/b&#62;');
    expect(out.text).not.toContain('<b>bot</b>');
    expect(out.text).toContain(MCP_RESOURCE);
    expect(out.text).toContain('<li>&#60;i&#62;agent-1&#60;/i&#62;</li>');
    expect(out.text).not.toContain('<i>agent-1</i>');
    expect(out.response.headers.get('x-frame-options')).toBe('DENY');
    expect(out.response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(out.response.headers.get('cache-control')).toBe('no-store');
  });

  it('shows the error page, not a shorter agent list, when an agent no longer exists', async () => {
    agentGone = true;
    const out = await authorizeGet(authorizeParams({ client_id: mcp.id, resource: MCP_RESOURCE }));
    expect(out.response.status).toBe(400);
    expect(out.response.headers.get('location')).toBeNull();
    expect(out.text).not.toContain('<form');
  });
});

describe('POST /oauth/authorize', () => {
  it('issues a single-use code bound to the challenge, redirect and resource, good for 60 seconds', async () => {
    const before = Date.now();
    const { response } = await authorizePost({ ...authorizeParams(), decision: 'approve' });
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get('state')).toBe('xyz');
    expect(location.searchParams.get('iss')).toBe(ORIGIN);
    const code = location.searchParams.get('code') ?? '';
    expect(parseOAuthToken('code', code)).not.toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clientId: a2a.id,
      kind: 'code',
      subjectPrincipalId: ownerId,
      resource: A2A_RESOURCE,
      codeChallenge: CHALLENGE,
      redirectUri: REDIRECT,
    });
    const ttl = (rows[0]?.expiresAt.getTime() ?? 0) - before;
    expect(ttl).toBeGreaterThan(55_000);
    expect(ttl).toBeLessThanOrEqual(61_000);
    expect(rows[0]?.tokenHash).not.toContain(code);
  });

  it('redirects access_denied, with state and iss, and issues nothing, on deny', async () => {
    const { response } = await authorizePost({ ...authorizeParams(), decision: 'deny' });
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('xyz');
    expect(location.searchParams.get('iss')).toBe(ORIGIN);
    expect(rows).toEqual([]);
  });

  it.each([
    ['no Origin', {}],
    ['a foreign Origin', { origin: 'https://evil.example' }],
    ['Origin: null', { origin: 'null' }],
  ])('refuses %s (CSRF) and issues nothing', async (_n, extra) => {
    const out = await authorizePost(
      { ...authorizeParams(), decision: 'approve' },
      { ...callerHeaders(ownerCaller), ...extra },
    );
    expect(out.response.status).toBe(400);
    expect(out.response.headers.get('location')).toBeNull();
    expect(rows).toEqual([]);
  });

  it('refuses a signed-out POST by sending it to /signin', async () => {
    const out = await authorizePost(
      { ...authorizeParams(), decision: 'approve' },
      { origin: ORIGIN },
    );
    expect(out.response.status).toBe(302);
    expect(rows).toEqual([]);
  });

  it('re-checks every GET refusal on POST: a member who cannot run the agents gets no code', async () => {
    cannotRun.add(ownerId);
    const { response } = await authorizePost({ ...authorizeParams(), decision: 'approve' });
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'access_denied',
    );
    expect(rows).toEqual([]);
  });

  it('refuses another workspace’s client on POST', async () => {
    const { response } = await authorizePost({
      ...authorizeParams({ client_id: foreign.id }),
      decision: 'approve',
    });
    expect(response.status).toBe(400);
    expect(rows).toEqual([]);
  });

  it('limits approvals per session: the 31st in a minute is 429', async () => {
    for (let i = 0; i < OAUTH_RATE_LIMITS.authorizePerSessionPerMinute; i += 1) {
      const out = await authorizePost({ ...authorizeParams(), decision: 'deny' });
      expect(out.response.status).toBe(303);
    }
    const limited = await authorizePost({ ...authorizeParams(), decision: 'approve' });
    expect(limited.response.status).toBe(429);
    expect(limited.response.headers.get('retry-after')).not.toBeNull();
    expect(limited.json()).toMatchObject({ error: 'temporarily_unavailable' });
    // Another member has a bucket of their own.
    const other = await authorizePost(
      { ...authorizeParams(), decision: 'deny' },
      { origin: ORIGIN, ...callerHeaders(viewerCaller) },
    );
    expect(other.response.status).toBe(303);
  });
});

describe('POST /oauth/token: authorization_code', () => {
  it('exchanges a code with the PKCE verifier for an access and a refresh token', async () => {
    const out = await send(tokenRequest(codeGrant(await approvedCode())), TOKEN);
    expect(out.response.status).toBe(200);
    expect(out.response.headers.get('cache-control')).toBe('no-store');
    expect(out.response.headers.get('pragma')).toBe('no-cache');
    const body = out.json();
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'endpoint' });
    expect(parseOAuthToken('access', body['access_token'])).not.toBeNull();
    expect(parseOAuthToken('refresh', body['refresh_token'])).not.toBeNull();
    const issued = rows.filter((r) => r.kind !== 'code');
    expect(issued.map((r) => r.kind).sort()).toEqual(['access', 'refresh']);
    expect(
      issued.every((r) => r.resource === A2A_RESOURCE && r.subjectPrincipalId === ownerId),
    ).toBe(true);
    const access = issued.find((r) => r.kind === 'access');
    expect((access?.expiresAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(3_500_000);
    // Only digests are stored.
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain(String(body['access_token']));
      expect(JSON.stringify(row)).not.toContain(String(body['refresh_token']));
    }
  });

  it('audits the grant as the member who consented, with no token in the record', async () => {
    const out = await send(tokenRequest(codeGrant(await approvedCode())), TOKEN);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      workspaceId: TEST_WORKSPACE_ID,
      actor: ownerId,
      event: {
        action: 'oauth-grant-issued',
        clientId: a2a.id,
        clientName: 'Helper',
        detail: 'authorization_code',
      },
    });
    expect(JSON.stringify(audits)).not.toContain(String(out.json()['access_token']));
  });

  it('refuses a replayed code and revokes the grant it produced', async () => {
    const code = await approvedCode();
    const first = await send(tokenRequest(codeGrant(code)), TOKEN);
    expect(first.response.status).toBe(200);
    const second = await send(tokenRequest(codeGrant(code)), TOKEN);
    expect(second.response.status).toBe(400);
    expect(second.json()).toMatchObject({ error: 'invalid_grant' });
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
    expect(audits.at(-1)).toMatchObject({
      actor: ownerId,
      event: { action: 'oauth-grant-revoked', clientId: a2a.id, detail: 'reuse' },
    });
    expect(JSON.stringify(audits)).not.toContain(code);
  });

  it('refuses a wrong PKCE verifier, and the code is spent', async () => {
    const code = await approvedCode();
    const wrong = await send(
      tokenRequest(codeGrant(code, { code_verifier: `${VERIFIER.slice(0, -1)}A` })),
      TOKEN,
    );
    expect(wrong.json()).toMatchObject({ error: 'invalid_grant' });
    const retry = await send(tokenRequest(codeGrant(code)), TOKEN);
    expect(retry.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses a missing verifier and a verifier equal to the challenge (no plain)', async () => {
    const none = { ...codeGrant(await approvedCode()) } as Record<string, string>;
    delete none['code_verifier'];
    expect((await send(tokenRequest(none), TOKEN)).json()).toMatchObject({
      error: 'invalid_grant',
    });
    const plain = await send(
      tokenRequest(codeGrant(await approvedCode(), { code_verifier: CHALLENGE })),
      TOKEN,
    );
    expect(plain.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses a different redirect_uri', async () => {
    const out = await send(
      tokenRequest(codeGrant(await approvedCode(), { redirect_uri: 'https://app.example/other' })),
      TOKEN,
    );
    expect(out.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses a code that another client presents', async () => {
    const code = await approvedCode();
    const out = await send(
      tokenRequest(codeGrant(code, { client_id: mcp.id }), basic(mcp.id, secret)),
      TOKEN,
    );
    expect(out.json()).toMatchObject({ error: 'invalid_grant' });
    // The rightful client's code is untouched.
    expect((await send(tokenRequest(codeGrant(code)), TOKEN)).response.status).toBe(200);
  });

  it('refuses an expired code', async () => {
    const code = await approvedCode();
    const row = rows[0];
    if (row === undefined) throw new Error('no code row');
    rows[0] = { ...row, expiresAt: new Date(Date.now() - 1) };
    const out = await send(tokenRequest(codeGrant(code)), TOKEN);
    expect(out.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses a resource other than the one the code was granted for', async () => {
    const out = await send(
      tokenRequest(codeGrant(await approvedCode(), { resource: MCP_RESOURCE })),
      TOKEN,
    );
    expect(out.json()).toMatchObject({ error: 'invalid_target' });
  });

  it('accepts the matching resource indicator', async () => {
    const out = await send(
      tokenRequest(codeGrant(await approvedCode(), { resource: A2A_RESOURCE })),
      TOKEN,
    );
    expect(out.response.status).toBe(200);
  });

  it('refuses an access token or a malformed string where a code belongs', async () => {
    const { access } = await issueTokens();
    expect((await send(tokenRequest(codeGrant(access)), TOKEN)).json()).toMatchObject({
      error: 'invalid_grant',
    });
    expect((await send(tokenRequest(codeGrant('awc_live_nope')), TOKEN)).json()).toMatchObject({
      error: 'invalid_grant',
    });
  });
});

describe('POST /oauth/token: audience', () => {
  it('stamps an mcp-project grant with the project URL and an a2a-agent grant with the agent URL', async () => {
    const mcpOut = await send(
      tokenRequest({ grant_type: 'client_credentials' }, basic(mcp.id, secret)),
      TOKEN,
    );
    expect(mcpOut.response.status).toBe(200);
    await issueTokens();
    const resources = new Map(
      rows.filter((r) => r.kind === 'access').map((r) => [r.clientId, r.resource]),
    );
    expect(resources.get(mcp.id)).toBe(MCP_RESOURCE);
    expect(resources.get(a2a.id)).toBe(A2A_RESOURCE);
  });
});

describe('POST /oauth/token: client_credentials', () => {
  it('issues an access token only, acting as the client’s principal, and audits it', async () => {
    const out = await send(
      tokenRequest({ grant_type: 'client_credentials', scope: 'endpoint' }, basic(mcp.id, secret)),
      TOKEN,
    );
    expect(out.response.status).toBe(200);
    expect(out.json()).not.toHaveProperty('refresh_token');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'access',
      subjectPrincipalId: ownerId,
      resource: MCP_RESOURCE,
    });
    expect(audits[0]).toMatchObject({
      actor: ownerId,
      event: { action: 'oauth-grant-issued', detail: 'client_credentials' },
    });
  });

  it('is for confidential clients only', async () => {
    const out = await send(
      tokenRequest({ grant_type: 'client_credentials', client_id: a2a.id }),
      TOKEN,
    );
    expect(out.response.status).toBe(400);
    expect(out.json()).toMatchObject({ error: 'unauthorized_client' });
    expect(rows).toEqual([]);
  });

  it('refuses another resource and another scope', async () => {
    const wrongTarget = await send(
      tokenRequest(
        { grant_type: 'client_credentials', resource: A2A_RESOURCE },
        basic(mcp.id, secret),
      ),
      TOKEN,
    );
    expect(wrongTarget.json()).toMatchObject({ error: 'invalid_target' });
    const wrongScope = await send(
      tokenRequest({ grant_type: 'client_credentials', scope: 'admin' }, basic(mcp.id, secret)),
      TOKEN,
    );
    expect(wrongScope.json()).toMatchObject({ error: 'invalid_scope' });
    expect(rows).toEqual([]);
  });

  it('refuses a grant type the server does not offer', async () => {
    const out = await send(tokenRequest({ grant_type: 'password' }, basic(mcp.id, secret)), TOKEN);
    expect(out.json()).toMatchObject({ error: 'unsupported_grant_type' });
  });
});

describe('POST /oauth/token: refresh_token', () => {
  const refreshGrant = (refresh: string): Record<string, string> => ({
    grant_type: 'refresh_token',
    client_id: a2a.id,
    refresh_token: refresh,
  });

  it('rotates: a new pair in the same family, and the old refresh token is spent', async () => {
    const { refresh } = await issueTokens();
    const out = await send(tokenRequest(refreshGrant(refresh)), TOKEN);
    expect(out.response.status).toBe(200);
    const body = out.json();
    expect(body['refresh_token']).not.toBe(refresh);
    const families = new Set(rows.map((r) => r.familyId));
    expect(families.size).toBe(1);
    expect(audits.map((a) => a.event.detail)).toEqual(['authorization_code', 'refresh_token']);
  });

  it('treats a replayed refresh token as theft and revokes the whole family', async () => {
    const { refresh } = await issueTokens();
    const rotated = await send(tokenRequest(refreshGrant(refresh)), TOKEN);
    const newRefresh = String(rotated.json()['refresh_token']);
    const replay = await send(tokenRequest(refreshGrant(refresh)), TOKEN);
    expect(replay.json()).toMatchObject({ error: 'invalid_grant' });
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
    expect(audits.at(-1)).toMatchObject({
      actor: ownerId,
      event: { action: 'oauth-grant-revoked', clientId: a2a.id, detail: 'reuse' },
    });
    expect(JSON.stringify(audits)).not.toContain(refresh);
    // The newest refresh token is dead too.
    const after = await send(tokenRequest(refreshGrant(newRefresh)), TOKEN);
    expect(after.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses another client’s refresh token', async () => {
    const { refresh } = await issueTokens();
    const out = await send(
      tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh }, basic(mcp.id, secret)),
      TOKEN,
    );
    expect(out.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses a refresh token for another resource', async () => {
    const { refresh } = await issueTokens();
    const out = await send(
      tokenRequest({ ...refreshGrant(refresh), resource: MCP_RESOURCE }),
      TOKEN,
    );
    expect(out.json()).toMatchObject({ error: 'invalid_target' });
  });
});

describe('client authentication', () => {
  const grant = { grant_type: 'client_credentials' };

  it('accepts client_secret_basic and client_secret_post', async () => {
    expect((await send(tokenRequest(grant, basic(mcp.id, secret)), TOKEN)).response.status).toBe(
      200,
    );
    expect(
      (await send(tokenRequest({ ...grant, client_id: mcp.id, client_secret: secret }), TOKEN))
        .response.status,
    ).toBe(200);
  });

  it('answers 401 invalid_client with a Basic challenge for a wrong secret', async () => {
    const wrong = (await mintClientSecret()).presented;
    const out = await send(tokenRequest(grant, basic(mcp.id, wrong)), TOKEN);
    expect(out.response.status).toBe(401);
    expect(out.response.headers.get('www-authenticate')).toBe('Basic realm="agent-workspace"');
    expect(out.json()).toMatchObject({ error: 'invalid_client' });
  });

  it('answers the same for an unknown client, a malformed id and a malformed secret', async () => {
    const wrong = await send(tokenRequest(grant, basic(mcp.id, 'awcs_live_nope')), TOKEN);
    const unknown = await send(tokenRequest(grant, basic(crypto.randomUUID(), secret)), TOKEN);
    const malformedId = await send(tokenRequest(grant, basic('not-a-uuid', secret)), TOKEN);
    for (const out of [wrong, unknown, malformedId]) {
      expect(out.response.status).toBe(401);
      expect(out.text).toBe(wrong.text);
    }
  });

  it('refuses a confidential client that sends no secret', async () => {
    const out = await send(tokenRequest({ ...grant, client_id: mcp.id }), TOKEN);
    expect(out.response.status).toBe(401);
  });

  it('refuses a public client that sends a secret', async () => {
    const out = await send(tokenRequest({ ...codeGrant('x'), client_secret: secret }), TOKEN);
    expect(out.response.status).toBe(401);
  });

  it('refuses two authentication methods at once, and a mismatched client_id', async () => {
    const both = await send(
      tokenRequest({ ...grant, client_secret: secret }, basic(mcp.id, secret)),
      TOKEN,
    );
    expect(both.response.status).toBe(400);
    expect(both.json()).toMatchObject({ error: 'invalid_request' });
    const mismatch = await send(
      tokenRequest({ ...grant, client_id: a2a.id }, basic(mcp.id, secret)),
      TOKEN,
    );
    expect(mismatch.response.status).toBe(400);
  });

  it('keeps a client of another workspace in its own workspace: its tokens and audit are scoped there', async () => {
    const out = await send(tokenRequest(grant, basic(foreign.id, secret)), TOKEN);
    expect(out.response.status).toBe(200);
    expect(rows[0]).toMatchObject({ clientId: foreign.id });
    expect(audits[0]?.workspaceId).toBe(OTHER_WORKSPACE);
  });

  it('refuses a body that is not form-encoded, or repeats a parameter', async () => {
    const json = await send(
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      TOKEN,
    );
    expect(json.response.status).toBe(400);
    const repeated = await send(
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&grant_type=password&client_id=${mcp.id}`,
      }),
      TOKEN,
    );
    expect(repeated.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('refuses a revoked or deleted client (the runtime finds none)', async () => {
    clients.delete(mcp.id);
    const out = await send(tokenRequest(grant, basic(mcp.id, secret)), TOKEN);
    expect(out.response.status).toBe(401);
  });
});

describe('rate limits on /oauth/*', () => {
  const from = (ip: string, pass: string, path = '/oauth/token') =>
    tokenRequest(
      path === '/oauth/token' ? { grant_type: 'client_credentials' } : { token: 'x' },
      { 'x-forwarded-for': ip, ...basic(mcp.id, pass) },
      path,
    );
  const behindProxy = (): void => {
    vi.stubEnv('AW_TRUSTED_PROXY_HOPS', '1');
    vi.stubEnv('SESSION_SECRET', PROXY_TEST_SECRET);
  };

  it('counts a client only once it authenticated: the 61st authenticated request is 429', async () => {
    for (let i = 0; i < OAUTH_RATE_LIMITS.perClientPerMinute; i += 1) {
      const out = await send(
        tokenRequest({ grant_type: 'client_credentials' }, basic(mcp.id, secret)),
        TOKEN,
      );
      expect(out.response.status).toBe(200);
    }
    const limited = await send(
      tokenRequest({ grant_type: 'client_credentials' }, basic(mcp.id, secret)),
      TOKEN,
    );
    expect(limited.response.status).toBe(429);
    expect(limited.response.headers.get('retry-after')).not.toBeNull();
    expect(limited.json()).toMatchObject({ error: 'temporarily_unavailable' });
    // Another client is not limited by this one's requests.
    const other = await send(
      tokenRequest({ grant_type: 'client_credentials', client_id: a2a.id }),
      TOKEN,
    );
    expect(other.response.status).toBe(400);
  });

  it('does not let failed authentications from one address lock a client out for another', async () => {
    behindProxy();
    const wrong = (await mintClientSecret()).presented;
    for (let i = 0; i <= OAUTH_RATE_LIMITS.perClientPerMinute; i += 1) {
      await send(from('203.0.113.20', wrong), TOKEN);
    }
    const real = await send(from('203.0.113.21', secret), TOKEN);
    expect(real.response.status).toBe(200);
  });

  it('throttles repeated failed authentications from one address', async () => {
    behindProxy();
    const wrong = (await mintClientSecret()).presented;
    for (let i = 0; i < OAUTH_RATE_LIMITS.failedAuthPerAddressPerMinute; i += 1) {
      const out = await send(from('203.0.113.30', wrong), TOKEN);
      expect(out.response.status).toBe(401);
    }
    // Even the right secret is refused before it is checked, so guessing is bounded.
    const limited = await send(from('203.0.113.30', secret), TOKEN);
    expect(limited.response.status).toBe(429);
    expect(limited.response.headers.get('retry-after')).not.toBeNull();
    const other = await send(from('203.0.113.31', secret), TOKEN);
    expect(other.response.status).toBe(200);
  });

  it('applies the same counters to revoke', async () => {
    behindProxy();
    const wrong = (await mintClientSecret()).presented;
    for (let i = 0; i < OAUTH_RATE_LIMITS.failedAuthPerAddressPerMinute; i += 1) {
      await send(from('203.0.113.40', wrong, '/oauth/revoke'), REVOKE);
    }
    const throttled = await send(from('203.0.113.40', secret, '/oauth/revoke'), REVOKE);
    expect(throttled.response.status).toBe(429);
    const other = await send(from('203.0.113.41', secret, '/oauth/revoke'), REVOKE);
    expect(other.response.status).toBe(200);
    for (let i = 1; i < OAUTH_RATE_LIMITS.perClientPerMinute; i += 1) {
      await send(from('203.0.113.41', secret, '/oauth/revoke'), REVOKE);
    }
    const limited = await send(from('203.0.113.41', secret, '/oauth/revoke'), REVOKE);
    expect(limited.response.status).toBe(429);
  });

  it('limits an address across clients, and another address keeps its own budget', () => {
    const at = (ip: string) => new Headers({ 'x-forwarded-for': ip });
    const env = { AW_TRUSTED_PROXY_HOPS: '1', SESSION_SECRET: PROXY_TEST_SECRET };
    for (let i = 0; i < OAUTH_RATE_LIMITS.perAddressPerMinute; i += 1) {
      expect(admitOAuthAddress(at('203.0.113.7'), 0, env).admitted).toBe(true);
    }
    const refused = admitOAuthAddress(at('203.0.113.7'), 0, env);
    expect(refused.admitted).toBe(false);
    expect(admitOAuthAddress(at('203.0.113.8'), 0, env).admitted).toBe(true);
  });

  it('refuses before anything is looked up when the address is over its limit', async () => {
    vi.stubEnv('AW_TRUSTED_PROXY_HOPS', '1');
    vi.stubEnv('SESSION_SECRET', PROXY_TEST_SECRET);
    const headers = { 'x-forwarded-for': '203.0.113.9' };
    for (let i = 0; i < OAUTH_RATE_LIMITS.perAddressPerMinute; i += 1) {
      admitOAuthAddress(new Headers(headers), Date.now());
    }
    const out = await send(
      tokenRequest({ grant_type: 'client_credentials' }, { ...headers, ...basic(mcp.id, secret) }),
      TOKEN,
    );
    expect(out.response.status).toBe(429);
    expect(rows).toEqual([]);
  });
});

describe('POST /oauth/revoke', () => {
  it('revokes an access token alone and answers an empty 200', async () => {
    const { access, refresh } = await issueTokens();
    const out = await send(
      tokenRequest({ client_id: a2a.id, token: access }, {}, '/oauth/revoke'),
      REVOKE,
    );
    expect(out.response.status).toBe(200);
    expect(out.text).toBe('');
    const states = new Map(
      rows.filter((r) => r.kind !== 'code').map((r) => [r.kind, r.revokedAt !== null]),
    );
    expect(states.get('access')).toBe(true);
    expect(states.get('refresh')).toBe(false);
    expect(audits.at(-1)).toMatchObject({
      actor: ownerId,
      event: { action: 'oauth-grant-revoked', clientId: a2a.id, detail: 'access' },
    });
    expect(refresh).toBeTruthy();
  });

  it('revokes the whole family when the token is a refresh token', async () => {
    const { refresh } = await issueTokens();
    await send(tokenRequest({ client_id: a2a.id, token: refresh }, {}, '/oauth/revoke'), REVOKE);
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
    expect(audits.at(-1)?.event.detail).toBe('refresh');
  });

  it('audits the revocation as the consenting member, not the client creator', async () => {
    clients.set(a2a.id, { ...a2a, actsForPrincipalId: viewerId });
    const { access } = await issueTokens();
    await send(tokenRequest({ client_id: a2a.id, token: access }, {}, '/oauth/revoke'), REVOKE);
    expect(audits.at(-1)).toMatchObject({
      actor: ownerId,
      event: { action: 'oauth-grant-revoked', detail: 'access' },
    });
  });

  it('audits a repeated revocation once and still answers 200', async () => {
    const { refresh } = await issueTokens();
    const before = audits.length;
    for (let i = 0; i < 2; i += 1) {
      const out = await send(
        tokenRequest({ client_id: a2a.id, token: refresh }, {}, '/oauth/revoke'),
        REVOKE,
      );
      expect(out.response.status).toBe(200);
    }
    expect(audits.slice(before).map((a) => a.event.action)).toEqual(['oauth-grant-revoked']);
  });

  it('audits two concurrent revocations of one token once and answers both 200', async () => {
    const { access } = await issueTokens();
    const before = audits.length;
    const outs = await Promise.all(
      [0, 1].map(() =>
        send(tokenRequest({ client_id: a2a.id, token: access }, {}, '/oauth/revoke'), REVOKE),
      ),
    );
    expect(outs.map((o) => o.response.status)).toEqual([200, 200]);
    expect(audits.slice(before).map((a) => a.event.action)).toEqual(['oauth-grant-revoked']);
  });

  it('answers 200 for an unknown token without revoking or auditing anything', async () => {
    const { access } = await issueTokens();
    const before = audits.length;
    const unknown = await send(
      tokenRequest({ client_id: a2a.id, token: 'awo_live_nothing' }, {}, '/oauth/revoke'),
      REVOKE,
    );
    expect(unknown.response.status).toBe(200);
    expect(audits).toHaveLength(before);
    expect(rows.some((r) => r.revokedAt !== null)).toBe(false);
    expect(access).toBeTruthy();
  });

  it('does not revoke another client’s token', async () => {
    const { access } = await issueTokens();
    const out = await send(
      tokenRequest({ token: access }, basic(mcp.id, secret), '/oauth/revoke'),
      REVOKE,
    );
    expect(out.response.status).toBe(200);
    expect(rows.some((r) => r.revokedAt !== null)).toBe(false);
  });

  it('refuses bad client credentials, and a request without a token', async () => {
    const { access } = await issueTokens();
    const bad = await send(
      tokenRequest({ token: access }, basic(mcp.id, 'awcs_live_nope'), '/oauth/revoke'),
      REVOKE,
    );
    expect(bad.response.status).toBe(401);
    const empty = await send(tokenRequest({ client_id: a2a.id }, {}, '/oauth/revoke'), REVOKE);
    expect(empty.response.status).toBe(400);
  });
});

describe('revoking a project client grant closes its tool sandbox', () => {
  let closed: [string, string][];
  const install = (closeSandbox: ToolEndpointEnvironment['closeSandbox']): void =>
    installToolEndpoint({ closeSandbox } as ToolEndpointEnvironment);
  const asProject = (): void => {
    clients.set(a2a.id, { ...a2a, kind: 'mcp-project' });
  };
  const refreshGrant = (refresh: string): Record<string, string> => ({
    grant_type: 'refresh_token',
    client_id: a2a.id,
    refresh_token: refresh,
  });

  beforeEach(() => {
    closed = [];
    install((workspaceId, clientId) => {
      closed.push([workspaceId, clientId]);
      return Promise.resolve();
    });
  });

  it('closes after an access token is revoked', async () => {
    asProject();
    const { access } = await issueTokens();
    await send(tokenRequest({ client_id: a2a.id, token: access }, {}, '/oauth/revoke'), REVOKE);
    expect(closed).toEqual([[TEST_WORKSPACE_ID, a2a.id]]);
  });

  it('closes after a refresh token is revoked', async () => {
    asProject();
    const { refresh } = await issueTokens();
    await send(tokenRequest({ client_id: a2a.id, token: refresh }, {}, '/oauth/revoke'), REVOKE);
    expect(closed).toEqual([[TEST_WORKSPACE_ID, a2a.id]]);
  });

  it('closes when a replayed refresh token revokes the family', async () => {
    asProject();
    const { refresh } = await issueTokens();
    await send(tokenRequest(refreshGrant(refresh)), TOKEN);
    expect(closed).toEqual([]);
    await send(tokenRequest(refreshGrant(refresh)), TOKEN);
    expect(closed).toEqual([[TEST_WORKSPACE_ID, a2a.id]]);
  });

  it('does not close for an a2a-agent client', async () => {
    const { access, refresh } = await issueTokens();
    await send(tokenRequest({ client_id: a2a.id, token: access }, {}, '/oauth/revoke'), REVOKE);
    await send(tokenRequest(refreshGrant(refresh)), TOKEN);
    await send(tokenRequest(refreshGrant(refresh)), TOKEN);
    expect(closed).toEqual([]);
  });

  it('answers an unknown token like a known one and closes nothing', async () => {
    asProject();
    const unknown = await send(
      tokenRequest({ client_id: a2a.id, token: 'awo_live_nothing' }, {}, '/oauth/revoke'),
      REVOKE,
    );
    expect(unknown.response.status).toBe(200);
    expect(unknown.text).toBe('');
    expect(closed).toEqual([]);
  });

  it('still answers 200 when the close fails', async () => {
    asProject();
    install(() => Promise.reject(new Error('manager down')));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { access } = await issueTokens();
    const out = await send(
      tokenRequest({ client_id: a2a.id, token: access }, {}, '/oauth/revoke'),
      REVOKE,
    );
    expect(out.response.status).toBe(200);
  });
});

describe('secrets and tokens stay out of everything but the issuing response', () => {
  it('writes no credential to a log, an error body or the audit trail', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    try {
      const code = await approvedCode();
      const issued = await send(tokenRequest(codeGrant(code)), TOKEN);
      const { access_token: access, refresh_token: refresh } = issued.json() as Record<
        string,
        string
      >;
      await send(tokenRequest(codeGrant(code)), TOKEN);
      await send(
        tokenRequest({ grant_type: 'client_credentials' }, basic(mcp.id, 'awcs_live_nope')),
        TOKEN,
      );
      await send(
        tokenRequest({ token: access ?? '', client_id: a2a.id }, {}, '/oauth/revoke'),
        REVOKE,
      );
      await send(
        tokenRequest({ token: refresh ?? '', client_id: a2a.id }, {}, '/oauth/revoke'),
        REVOKE,
      );

      const credentials = [code, access, refresh, secret].filter(
        (v): v is string => typeof v === 'string',
      );
      const others = bodies.filter((b) => b !== issued.text);
      const logs = spies
        .flatMap((spy) => spy.mock.calls.map((args) => JSON.stringify(args)))
        .join(' ');
      for (const credential of credentials) {
        expect(logs).not.toContain(credential);
        expect(JSON.stringify(audits)).not.toContain(credential);
        for (const body of others) {
          // The consent redirect carries the code in a header, not a body.
          expect(body).not.toContain(credential);
        }
      }
      expect(issued.text).toContain(String(access));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('never echoes a viewer’s consent: a viewer who can run nothing is refused with no code', async () => {
    cannotRun.add(viewerId);
    const { response } = await authorizePost(
      { ...authorizeParams(), decision: 'approve' },
      { origin: ORIGIN, ...callerHeaders(viewerCaller) },
    );
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'access_denied',
    );
    expect(rows).toEqual([]);
  });
});
