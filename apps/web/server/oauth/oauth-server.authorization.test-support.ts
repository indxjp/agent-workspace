import { describe, expect, it } from 'vitest';
import { GET as AUTHORIZE_GET } from '../../app/oauth/authorize/route';
import { applicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { conferredBy } from '../rbac/core/conferral';
import { Principal } from '../rbac/principal';
import { callerHeaders, TEST_WORKSPACE_ID } from '../rbac/testing';
import { OAUTH_RATE_LIMITS } from './limits';
import {
  A2A_RESOURCE,
  authorizeGet,
  authorizeParams,
  authorizePost,
  CHALLENGE,
  fixture,
  MCP_RESOURCE,
  ORIGIN,
  ownerCaller,
  REDIRECT,
  send,
  urlencoded,
  viewerCaller,
} from './oauth-server.test-support';
import { parseOAuthToken } from './tokens';

describe('GET /oauth/authorize', () => {
  it('sends a signed-out visitor to /signin with a way back', sendsSignedOutVisitorSigninWayBack);

  it(
    'refuses an API key: only a browser session consents',
    refusesAPIKeyOnlyBrowserSessionConsents,
  );

  it.each([
    ['a browser token', 'browser-token'],
    ['a user token', 'user-token'],
  ] as const)('refuses %s: only a browser session consents', refusesTokenConsent);

  it(
    'shows an error page, and never redirects, for a client of another workspace',
    showsErrorPageNeverRedirectsClientAnotherWorkspace,
  );

  it('shows the same page for an unknown client', showsSamePageUnknownClient);

  it.each([
    ['an unregistered address', 'https://evil.example/callback'],
    ['a prefix of a registered one', 'https://app.example/call'],
    ['a registered one with a suffix', `${REDIRECT}/x`],
    ['a registered one with a query', `${REDIRECT}?a=1`],
  ])(
    'requires an exact redirect_uri (%s) and shows a page instead of redirecting',
    requiresExactRedirect,
  );

  it.each<[string, Record<string, string>]>([
    ['plain PKCE', { code_challenge_method: 'plain' }],
    ['no code_challenge_method', { code_challenge_method: '' }],
    ['a malformed challenge', { code_challenge: 'short' }],
  ])('redirects invalid_request for %s', redirectsInvalidPkce);

  it('refuses a missing code_challenge', refusesMissingCodeChallenge);

  it('refuses another response_type and another scope', refusesAnotherResponseTypeAnotherScope);

  it(
    'binds the grant to the resource: a different resource is invalid_target',
    bindsGrantResourceDifferentResourceIsInvalidTarget,
  );

  it(
    'refuses a member who cannot run every agent the client reaches',
    refusesMemberWhoCannotRunEveryAgentClient,
  );

  it('refuses a client whose agent is gone (no resource)', refusesClientWhoseAgentIsGoneNoResource);

  it(
    'renders the consent page with the client name escaped and framing refused',
    rendersConsentPageClientNameEscapedFramingRefused,
  );

  it(
    'shows the error page, not a shorter agent list, when an agent no longer exists',
    showsErrorPageNotShorterAgentListWhen,
  );
});

describe('POST /oauth/authorize', () => {
  it(
    'issues a single-use code bound to the challenge, redirect and resource, good for 60 seconds',
    issuesSingleUseCodeBoundChallengeRedirectResource,
  );

  it(
    'redirects access_denied, with state and iss, and issues nothing, on deny',
    redirectsAccessDeniedStateIssIssuesNothingDeny,
  );

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
    expect(fixture.rows).toEqual([]);
  });

  it('refuses a signed-out POST by sending it to /signin', refusesSignedOutPOSTSendingItSignin);

  it(
    're-checks every GET refusal on POST: a member who cannot run the agents gets no code',
    reChecksEveryGETRefusalPOSTMemberWho,
  );

  it('refuses another workspace’s client on POST', refusesAnotherWorkspaceSClientPOST);

  it(
    'limits approvals per session: the 31st in a minute is 429',
    limitsApprovalsPerSession31stMinuteIs429,
  );
});

async function sendsSignedOutVisitorSigninWayBack() {
  const out = await authorizeGet(authorizeParams(), null);
  expect(out.response.status).toBe(302);
  const location = out.response.headers.get('location') ?? '';
  expect(location.startsWith('/signin?next=')).toBe(true);
  expect(decodeURIComponent(location.slice('/signin?next='.length))).toContain('/oauth/authorize?');
}

async function refusesAPIKeyOnlyBrowserSessionConsents() {
  const created = await fixture.harness.directory.forWorkspace(TEST_WORKSPACE_ID).createApiKey({
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
}

async function showsErrorPageNeverRedirectsClientAnotherWorkspace() {
  const out = await authorizeGet(authorizeParams({ client_id: fixture.foreign.id }));
  expect(out.response.status).toBe(400);
  expect(out.response.headers.get('location')).toBeNull();
}

async function showsSamePageUnknownClient() {
  const out = await authorizeGet(authorizeParams({ client_id: crypto.randomUUID() }));
  expect(out.response.status).toBe(400);
  expect(out.response.headers.get('location')).toBeNull();
}

async function refusesMissingCodeChallenge() {
  const params = authorizeParams();
  delete params['code_challenge'];
  const out = await authorizeGet(params);
  expect(new URL(out.response.headers.get('location') ?? '').searchParams.get('error')).toBe(
    'invalid_request',
  );
}

async function refusesAnotherResponseTypeAnotherScope() {
  const type = await authorizeGet(authorizeParams({ response_type: 'token' }));
  expect(new URL(type.response.headers.get('location') ?? '').searchParams.get('error')).toBe(
    'unsupported_response_type',
  );
  const scope = await authorizeGet(authorizeParams({ scope: 'admin' }));
  expect(new URL(scope.response.headers.get('location') ?? '').searchParams.get('error')).toBe(
    'invalid_scope',
  );
}

async function bindsGrantResourceDifferentResourceIsInvalidTarget() {
  const out = await authorizeGet(authorizeParams({ resource: MCP_RESOURCE }));
  expect(new URL(out.response.headers.get('location') ?? '').searchParams.get('error')).toBe(
    'invalid_target',
  );
}

async function refusesMemberWhoCannotRunEveryAgentClient() {
  fixture.cannotRun.add(fixture.ownerId);
  const out = await authorizeGet(authorizeParams());
  expect(new URL(out.response.headers.get('location') ?? '').searchParams.get('error')).toBe(
    'access_denied',
  );
}

async function refusesClientWhoseAgentIsGoneNoResource() {
  fixture.clients.set(fixture.a2a.id, { ...fixture.a2a, resourcePath: null });
  const out = await authorizeGet(authorizeParams());
  expect(new URL(out.response.headers.get('location') ?? '').searchParams.get('error')).toBe(
    'invalid_target',
  );
}

async function rendersConsentPageClientNameEscapedFramingRefused() {
  const out = await authorizeGet(
    authorizeParams({ client_id: fixture.mcp.id, resource: MCP_RESOURCE }),
  );
  expect(out.response.status).toBe(200);
  expect(out.text).toContain('Docs &#60;b&#62;bot&#60;/b&#62;');
  expect(out.text).not.toContain('<b>bot</b>');
  expect(out.text).toContain(MCP_RESOURCE);
  expect(out.text).toContain('<li>&#60;i&#62;agent-1&#60;/i&#62;</li>');
  expect(out.text).not.toContain('<i>agent-1</i>');
  expect(out.response.headers.get('x-frame-options')).toBe('DENY');
  expect(out.response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect(out.response.headers.get('cache-control')).toBe('no-store');
}

async function showsErrorPageNotShorterAgentListWhen() {
  fixture.agentGone = true;
  const out = await authorizeGet(
    authorizeParams({ client_id: fixture.mcp.id, resource: MCP_RESOURCE }),
  );
  expect(out.response.status).toBe(400);
  expect(out.response.headers.get('location')).toBeNull();
  expect(out.text).not.toContain('<form');
}

async function issuesSingleUseCodeBoundChallengeRedirectResource() {
  const before = Date.now();
  const { response } = await authorizePost({ ...authorizeParams(), decision: 'approve' });
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get('location') ?? '');
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
  expect(location.searchParams.get('state')).toBe('xyz');
  expect(location.searchParams.get('iss')).toBe(ORIGIN);
  const code = location.searchParams.get('code') ?? '';
  expect(parseOAuthToken('code', code)).not.toBeNull();
  expect(fixture.rows).toHaveLength(1);
  expect(fixture.rows[0]).toMatchObject({
    clientId: fixture.a2a.id,
    kind: 'code',
    subjectPrincipalId: fixture.ownerId,
    resource: A2A_RESOURCE,
    codeChallenge: CHALLENGE,
    redirectUri: REDIRECT,
  });
  const ttl = (fixture.rows[0]?.expiresAt.getTime() ?? 0) - before;
  expect(ttl).toBeGreaterThan(55_000);
  expect(ttl).toBeLessThanOrEqual(61_000);
  expect(fixture.rows[0]?.tokenHash).not.toContain(code);
}

async function redirectsAccessDeniedStateIssIssuesNothingDeny() {
  const { response } = await authorizePost({ ...authorizeParams(), decision: 'deny' });
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get('location') ?? '');
  expect(location.searchParams.get('error')).toBe('access_denied');
  expect(location.searchParams.get('state')).toBe('xyz');
  expect(location.searchParams.get('iss')).toBe(ORIGIN);
  expect(fixture.rows).toEqual([]);
}

async function refusesSignedOutPOSTSendingItSignin() {
  const out = await authorizePost(
    { ...authorizeParams(), decision: 'approve' },
    { origin: ORIGIN },
  );
  expect(out.response.status).toBe(302);
  expect(fixture.rows).toEqual([]);
}

async function reChecksEveryGETRefusalPOSTMemberWho() {
  fixture.cannotRun.add(fixture.ownerId);
  const { response } = await authorizePost({ ...authorizeParams(), decision: 'approve' });
  expect(new URL(response.headers.get('location') ?? '').searchParams.get('error')).toBe(
    'access_denied',
  );
  expect(fixture.rows).toEqual([]);
}

async function refusesAnotherWorkspaceSClientPOST() {
  const { response } = await authorizePost({
    ...authorizeParams({ client_id: fixture.foreign.id }),
    decision: 'approve',
  });
  expect(response.status).toBe(400);
  expect(fixture.rows).toEqual([]);
}

async function limitsApprovalsPerSession31stMinuteIs429() {
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
}

async function refusesTokenConsent(_name: string, via: 'browser-token' | 'user-token') {
  const rbac = applicationContext()?.rbac ?? null;
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
  installTestDomains({ rbac: { ...rbac, identify: () => Promise.resolve(principal) } });

  const get = await authorizeGet(authorizeParams());
  expect(get.response.status).toBe(403);
  expect(get.json()).toMatchObject({ error: 'access_denied' });
  const post = await authorizePost({ ...authorizeParams(), decision: 'approve' });
  expect(post.response.status).toBe(403);
  expect(post.response.headers.get('location')).toBeNull();
  expect(fixture.rows).toEqual([]);
}

async function requiresExactRedirect(_name: string, uri: string) {
  const out = await authorizeGet(authorizeParams({ redirect_uri: uri }));
  expect(out.response.status).toBe(400);
  expect(out.response.headers.get('location')).toBeNull();
}

async function redirectsInvalidPkce(_name: string, over: Record<string, string>) {
  const params = authorizeParams(over);
  if (over['code_challenge_method'] === '') delete params['code_challenge_method'];
  const out = await authorizeGet(params);
  expect(out.response.status).toBe(302);
  const location = new URL(out.response.headers.get('location') ?? '');
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
  expect(location.searchParams.get('error')).toBe('invalid_request');
  expect(location.searchParams.get('state')).toBe('xyz');
  expect(location.searchParams.get('iss')).toBe(ORIGIN);
}
