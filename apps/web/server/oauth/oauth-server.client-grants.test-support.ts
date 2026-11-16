import { describe, expect, it } from 'vitest';
import { POST as TOKEN } from '../../app/oauth/token/route';
import {
  A2A_RESOURCE,
  approvedCode,
  authorizeGet,
  authorizeParams,
  authorizePost,
  basic,
  BUILDER_RESOURCE,
  client,
  codeGrant,
  fixture,
  issueTokens,
  MCP_RESOURCE,
  REDIRECT,
  send,
  tokenRequest,
  viewerCaller,
} from './oauth-server.test-support';
import { mintClientSecret } from './tokens';

const params = (over: Record<string, string> = {}) =>
  authorizeParams({ client_id: fixture.builder.id, resource: BUILDER_RESOURCE, ...over });

const errorOf = (out: { response: Response }) =>
  new URL(out.response.headers.get('location') ?? '').searchParams.get('error');

const refreshGrant = (refresh: string): Record<string, string> => ({
  grant_type: 'refresh_token',
  client_id: fixture.a2a.id,
  refresh_token: refresh,
});

describe('a builder client (#1846 slice 5a)', () => {
  it(
    'issues a code and tokens whose audience is /mcp/builder, for the consenting member',
    issuesCodeTokensWhoseAudienceIsMcpBuilder,
  );

  it(
    'is consented to by a member with no agent grant: the consent page names no agent',
    isConsentedMemberNoAgentGrantConsentPage,
  );

  it(
    'shows the redirect host and the member who registered the client on the consent page',
    showsRedirectHostMemberWhoRegisteredClientConsent,
  );

  it.each([
    ['an mcp-project client', () => fixture.mcp],
    ['an a2a-agent client', () => fixture.a2a],
  ])('cannot obtain the /mcp/builder audience as %s', async (_name, pick) => {
    const other = pick();
    const authorize = await authorizeGet(
      authorizeParams({ client_id: other.id, resource: BUILDER_RESOURCE }),
    );
    expect(errorOf(authorize)).toBe('invalid_target');
    const code = await approvedCode({ client_id: other.id });
    const exchange = await send(
      tokenRequest(
        codeGrant(code, { client_id: other.id, resource: BUILDER_RESOURCE }),
        other === fixture.mcp ? basic(fixture.mcp.id, fixture.secret) : {},
      ),
      TOKEN,
    );
    expect(exchange.json()).toMatchObject({ error: 'invalid_target' });
    const credentials = await send(
      tokenRequest(
        { grant_type: 'client_credentials', resource: BUILDER_RESOURCE },
        basic(fixture.mcp.id, fixture.secret),
      ),
      TOKEN,
    );
    expect(credentials.json()).toMatchObject({ error: 'invalid_target' });
    expect(fixture.rows.filter((r) => r.resource === BUILDER_RESOURCE)).toEqual([]);
  });

  it.each([MCP_RESOURCE, A2A_RESOURCE])('cannot obtain another audience (%s)', async (resource) => {
    expect(errorOf(await authorizeGet(params({ resource })))).toBe('invalid_target');
    const code = await approvedCode({ client_id: fixture.builder.id, resource: BUILDER_RESOURCE });
    const out = await send(
      tokenRequest(codeGrant(code, { client_id: fixture.builder.id, resource })),
      TOKEN,
    );
    expect(out.json()).toMatchObject({ error: 'invalid_target' });
    const refresh = await send(
      tokenRequest(
        codeGrant(
          await approvedCode({ client_id: fixture.builder.id, resource: BUILDER_RESOURCE }),
          {
            client_id: fixture.builder.id,
          },
        ),
      ),
      TOKEN,
    );
    const refreshOut = await send(
      tokenRequest({
        grant_type: 'refresh_token',
        client_id: fixture.builder.id,
        refresh_token: String(refresh.json()['refresh_token']),
        resource,
      }),
      TOKEN,
    );
    expect(refreshOut.json()).toMatchObject({ error: 'invalid_target' });
  });

  it(
    'has no client_credentials grant: its subject would be a member who never consented',
    hasNoClientCredentialsGrantSubjectWouldBe,
  );
});

describe('POST /oauth/token: an app-backend client (ADR-0161 D4)', () => {
  it(
    'is unauthorized_client for every grant: its tokens come from the ID-token exchange',
    isUnauthorizedClientEveryGrantTokensComeID,
  );
});

describe('POST /oauth/token: client_credentials', () => {
  it(
    'issues an access token only, acting as the client’s principal, and audits it',
    issuesAccessTokenOnlyActingClientSPrincipal,
  );

  it('is for confidential clients only', isConfidentialClientsOnly);

  it('refuses another resource and another scope', refusesAnotherResourceAnotherScope);

  it('refuses a grant type the server does not offer', refusesGrantTypeServerDoesNotOffer);
});

describe('POST /oauth/token: refresh_token', () => {
  it(
    'rotates: a new pair in the same family, and the old refresh token is spent',
    rotatesNewPairSameFamilyOldRefreshToken,
  );

  it(
    'treats a replayed refresh token as theft and revokes the whole family',
    treatsReplayedRefreshTokenTheftRevokesWholeFamily,
  );

  it('refuses another client’s refresh token', refusesAnotherClientSRefreshToken);

  it('refuses a refresh token for another resource', refusesRefreshTokenAnotherResource);
});

async function hasNoClientCredentialsGrantSubjectWouldBe() {
  const out = await send(
    tokenRequest(
      { grant_type: 'client_credentials' },
      basic(fixture.builderConfidential.id, fixture.secret),
    ),
    TOKEN,
  );
  expect(out.response.status).toBe(400);
  expect(out.json()).toMatchObject({ error: 'unauthorized_client' });
  expect(fixture.rows).toEqual([]);
}

async function isUnauthorizedClientEveryGrantTokensComeID() {
  const appBackend = client({
    id: crypto.randomUUID(),
    name: 'portal',
    kind: 'app-backend',
    oidcAudience: 'portal-web',
    redirectUris: [],
    resourcePath: null,
    clientSecretHash: (await mintClientSecret()).secretHash,
  });
  fixture.clients.set(appBackend.id, {
    ...appBackend,
    clientSecretHash: fixture.mcp.clientSecretHash,
  });
  for (const grant of ['client_credentials', 'authorization_code', 'refresh_token']) {
    const out = await send(
      tokenRequest({ grant_type: grant }, basic(appBackend.id, fixture.secret)),
      TOKEN,
    );
    expect(out.response.status, grant).toBe(400);
    expect(out.json()).toMatchObject({ error: 'unauthorized_client' });
  }
  expect(fixture.rows).toEqual([]);
  expect(fixture.audits).toEqual([]);
}

async function issuesAccessTokenOnlyActingClientSPrincipal() {
  const out = await send(
    tokenRequest(
      { grant_type: 'client_credentials', scope: 'endpoint' },
      basic(fixture.mcp.id, fixture.secret),
    ),
    TOKEN,
  );
  expect(out.response.status).toBe(200);
  expect(out.json()).not.toHaveProperty('refresh_token');
  expect(fixture.rows).toHaveLength(1);
  expect(fixture.rows[0]).toMatchObject({
    kind: 'access',
    subjectPrincipalId: fixture.ownerId,
    resource: MCP_RESOURCE,
  });
  expect(fixture.audits[0]).toMatchObject({
    actor: fixture.ownerId,
    event: { action: 'oauth-grant-issued', detail: 'client_credentials' },
  });
}

async function isConfidentialClientsOnly() {
  const out = await send(
    tokenRequest({ grant_type: 'client_credentials', client_id: fixture.a2a.id }),
    TOKEN,
  );
  expect(out.response.status).toBe(400);
  expect(out.json()).toMatchObject({ error: 'unauthorized_client' });
  expect(fixture.rows).toEqual([]);
}

async function refusesAnotherResourceAnotherScope() {
  const wrongTarget = await send(
    tokenRequest(
      { grant_type: 'client_credentials', resource: A2A_RESOURCE },
      basic(fixture.mcp.id, fixture.secret),
    ),
    TOKEN,
  );
  expect(wrongTarget.json()).toMatchObject({ error: 'invalid_target' });
  const wrongScope = await send(
    tokenRequest(
      { grant_type: 'client_credentials', scope: 'admin' },
      basic(fixture.mcp.id, fixture.secret),
    ),
    TOKEN,
  );
  expect(wrongScope.json()).toMatchObject({ error: 'invalid_scope' });
  expect(fixture.rows).toEqual([]);
}

async function refusesGrantTypeServerDoesNotOffer() {
  const out = await send(
    tokenRequest({ grant_type: 'password' }, basic(fixture.mcp.id, fixture.secret)),
    TOKEN,
  );
  expect(out.json()).toMatchObject({ error: 'unsupported_grant_type' });
}

async function refusesAnotherClientSRefreshToken() {
  const { refresh } = await issueTokens();
  const out = await send(
    tokenRequest(
      { grant_type: 'refresh_token', refresh_token: refresh },
      basic(fixture.mcp.id, fixture.secret),
    ),
    TOKEN,
  );
  expect(out.json()).toMatchObject({ error: 'invalid_grant' });
}

async function issuesCodeTokensWhoseAudienceIsMcpBuilder() {
  const { response } = await authorizePost({ ...params(), decision: 'approve' });
  expect(response.status).toBe(303);
  const code = new URL(response.headers.get('location') ?? '').searchParams.get('code') ?? '';
  expect(fixture.rows[0]).toMatchObject({
    clientId: fixture.builder.id,
    kind: 'code',
    subjectPrincipalId: fixture.ownerId,
    resource: BUILDER_RESOURCE,
  });
  const out = await send(
    tokenRequest(codeGrant(code, { client_id: fixture.builder.id, resource: BUILDER_RESOURCE })),
    TOKEN,
  );
  expect(out.response.status).toBe(200);
  const access = fixture.rows.find((r) => r.kind === 'access');
  expect(access).toMatchObject({
    clientId: fixture.builder.id,
    subjectPrincipalId: fixture.ownerId,
    resource: BUILDER_RESOURCE,
  });
}

async function isConsentedMemberNoAgentGrantConsentPage() {
  const out = await authorizeGet(params(), viewerCaller);
  expect(out.response.status).toBe(200);
  expect(out.text).toContain(BUILDER_RESOURCE);
  expect(out.text).toContain('as you, with your role');
  expect(out.text).not.toContain('It reaches these agents');
}

async function showsRedirectHostMemberWhoRegisteredClientConsent() {
  fixture.clients.set(fixture.builder.id, {
    ...fixture.builder,
    creatorLabel: 'Ada <i>Lovelace</i>',
  });
  const out = await authorizeGet(params());
  expect(out.text).toContain('Registered by <strong>Ada &#60;i&#62;Lovelace&#60;/i&#62;</strong>');
  expect(out.text).toContain(`<code>${new URL(REDIRECT).host}</code>`);
}

async function rotatesNewPairSameFamilyOldRefreshToken() {
  const { refresh } = await issueTokens();
  const out = await send(tokenRequest(refreshGrant(refresh)), TOKEN);
  expect(out.response.status).toBe(200);
  const body = out.json();
  expect(body['refresh_token']).not.toBe(refresh);
  const families = new Set(fixture.rows.map((r) => r.familyId));
  expect(families.size).toBe(1);
  expect(fixture.audits.map((a) => a.event.detail)).toEqual([
    'authorization_code',
    'refresh_token',
  ]);
}

async function treatsReplayedRefreshTokenTheftRevokesWholeFamily() {
  const { refresh } = await issueTokens();
  const rotated = await send(tokenRequest(refreshGrant(refresh)), TOKEN);
  const newRefresh = String(rotated.json()['refresh_token']);
  const replay = await send(tokenRequest(refreshGrant(refresh)), TOKEN);
  expect(replay.json()).toMatchObject({ error: 'invalid_grant' });
  expect(fixture.rows.every((r) => r.revokedAt !== null)).toBe(true);
  expect(fixture.audits.at(-1)).toMatchObject({
    actor: fixture.ownerId,
    event: { action: 'oauth-grant-revoked', clientId: fixture.a2a.id, detail: 'reuse' },
  });
  expect(JSON.stringify(fixture.audits)).not.toContain(refresh);
  // The newest refresh token is dead too.
  const after = await send(tokenRequest(refreshGrant(newRefresh)), TOKEN);
  expect(after.json()).toMatchObject({ error: 'invalid_grant' });
}

async function refusesRefreshTokenAnotherResource() {
  const { refresh } = await issueTokens();
  const out = await send(tokenRequest({ ...refreshGrant(refresh), resource: MCP_RESOURCE }), TOKEN);
  expect(out.json()).toMatchObject({ error: 'invalid_target' });
}
