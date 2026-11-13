import { describe, expect, it } from 'vitest';
import { POST as TOKEN } from '../../app/oauth/token/route';
import { TEST_WORKSPACE_ID } from '../rbac/testing';
import {
  A2A_RESOURCE,
  approvedCode,
  basic,
  CHALLENGE,
  codeGrant,
  fixture,
  issueTokens,
  MCP_RESOURCE,
  send,
  tokenRequest,
  VERIFIER,
} from './oauth-server.test-support';
import { parseOAuthToken } from './tokens';

describe('POST /oauth/token: authorization_code', () => {
  it(
    'exchanges a code with the PKCE verifier for an access and a refresh token',
    exchangesCodePKCEVerifierAccessRefreshToken,
  );

  it(
    'audits the grant as the member who consented, with no token in the record',
    auditsGrantMemberWhoConsentedNoTokenRecord,
  );

  it(
    'refuses a replayed code and revokes the grant it produced',
    refusesReplayedCodeRevokesGrantItProduced,
  );

  it('refuses a wrong PKCE verifier, and the code is spent', refusesWrongPKCEVerifierCodeIsSpent);

  it(
    'refuses a missing verifier and a verifier equal to the challenge (no plain)',
    refusesMissingVerifierVerifierEqualChallengeNoPlain,
  );

  it('refuses a different redirect_uri', refusesDifferentRedirectUri);

  it('refuses a code that another client presents', refusesCodeThatAnotherClientPresents);

  it('refuses an expired code', refusesExpiredCode);

  it(
    'refuses a resource other than the one the code was granted for',
    refusesResourceOtherThanOneCodeWasGranted,
  );

  it('accepts the matching resource indicator', acceptsMatchingResourceIndicator);

  it(
    'refuses an access token or a malformed string where a code belongs',
    refusesAccessTokenMalformedStringWhereCodeBelongs,
  );
});

describe('POST /oauth/token: audience', () => {
  it(
    'stamps an mcp-project grant with the project URL and an a2a-agent grant with the agent URL',
    stampsMcpProjectGrantProjectURLA2aAgent,
  );
});

async function exchangesCodePKCEVerifierAccessRefreshToken() {
  const out = await send(tokenRequest(codeGrant(await approvedCode())), TOKEN);
  expect(out.response.status).toBe(200);
  expect(out.response.headers.get('cache-control')).toBe('no-store');
  expect(out.response.headers.get('pragma')).toBe('no-cache');
  const body = out.json();
  expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'endpoint' });
  expect(parseOAuthToken('access', body['access_token'])).not.toBeNull();
  expect(parseOAuthToken('refresh', body['refresh_token'])).not.toBeNull();
  const issued = fixture.rows.filter((r) => r.kind !== 'code');
  expect(issued.map((r) => r.kind).sort()).toEqual(['access', 'refresh']);
  expect(
    issued.every((r) => r.resource === A2A_RESOURCE && r.subjectPrincipalId === fixture.ownerId),
  ).toBe(true);
  const access = issued.find((r) => r.kind === 'access');
  expect((access?.expiresAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(3_500_000);
  // Only digests are stored.
  for (const row of fixture.rows) {
    expect(JSON.stringify(row)).not.toContain(String(body['access_token']));
    expect(JSON.stringify(row)).not.toContain(String(body['refresh_token']));
  }
}

async function auditsGrantMemberWhoConsentedNoTokenRecord() {
  const out = await send(tokenRequest(codeGrant(await approvedCode())), TOKEN);
  expect(fixture.audits).toHaveLength(1);
  expect(fixture.audits[0]).toMatchObject({
    workspaceId: TEST_WORKSPACE_ID,
    actor: fixture.ownerId,
    event: {
      action: 'oauth-grant-issued',
      clientId: fixture.a2a.id,
      clientName: 'Helper',
      detail: 'authorization_code',
    },
  });
  expect(JSON.stringify(fixture.audits)).not.toContain(String(out.json()['access_token']));
}

async function refusesReplayedCodeRevokesGrantItProduced() {
  const code = await approvedCode();
  const first = await send(tokenRequest(codeGrant(code)), TOKEN);
  expect(first.response.status).toBe(200);
  const second = await send(tokenRequest(codeGrant(code)), TOKEN);
  expect(second.response.status).toBe(400);
  expect(second.json()).toMatchObject({ error: 'invalid_grant' });
  expect(fixture.rows.every((r) => r.revokedAt !== null)).toBe(true);
  expect(fixture.audits.at(-1)).toMatchObject({
    actor: fixture.ownerId,
    event: { action: 'oauth-grant-revoked', clientId: fixture.a2a.id, detail: 'reuse' },
  });
  expect(JSON.stringify(fixture.audits)).not.toContain(code);
}

async function refusesWrongPKCEVerifierCodeIsSpent() {
  const code = await approvedCode();
  const wrong = await send(
    tokenRequest(codeGrant(code, { code_verifier: `${VERIFIER.slice(0, -1)}A` })),
    TOKEN,
  );
  expect(wrong.json()).toMatchObject({ error: 'invalid_grant' });
  const retry = await send(tokenRequest(codeGrant(code)), TOKEN);
  expect(retry.json()).toMatchObject({ error: 'invalid_grant' });
}

async function refusesMissingVerifierVerifierEqualChallengeNoPlain() {
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
}

async function refusesDifferentRedirectUri() {
  const out = await send(
    tokenRequest(codeGrant(await approvedCode(), { redirect_uri: 'https://app.example/other' })),
    TOKEN,
  );
  expect(out.json()).toMatchObject({ error: 'invalid_grant' });
}

async function refusesCodeThatAnotherClientPresents() {
  const code = await approvedCode();
  const out = await send(
    tokenRequest(
      codeGrant(code, { client_id: fixture.mcp.id }),
      basic(fixture.mcp.id, fixture.secret),
    ),
    TOKEN,
  );
  expect(out.json()).toMatchObject({ error: 'invalid_grant' });
  // The rightful client's code is untouched.
  expect((await send(tokenRequest(codeGrant(code)), TOKEN)).response.status).toBe(200);
}

async function refusesExpiredCode() {
  const code = await approvedCode();
  const row = fixture.rows[0];
  if (row === undefined) throw new Error('no code row');
  fixture.rows[0] = { ...row, expiresAt: new Date(Date.now() - 1) };
  const out = await send(tokenRequest(codeGrant(code)), TOKEN);
  expect(out.json()).toMatchObject({ error: 'invalid_grant' });
}

async function refusesResourceOtherThanOneCodeWasGranted() {
  const out = await send(
    tokenRequest(codeGrant(await approvedCode(), { resource: MCP_RESOURCE })),
    TOKEN,
  );
  expect(out.json()).toMatchObject({ error: 'invalid_target' });
}

async function acceptsMatchingResourceIndicator() {
  const out = await send(
    tokenRequest(codeGrant(await approvedCode(), { resource: A2A_RESOURCE })),
    TOKEN,
  );
  expect(out.response.status).toBe(200);
}

async function refusesAccessTokenMalformedStringWhereCodeBelongs() {
  const { access } = await issueTokens();
  expect((await send(tokenRequest(codeGrant(access)), TOKEN)).json()).toMatchObject({
    error: 'invalid_grant',
  });
  expect((await send(tokenRequest(codeGrant('awc_live_nope')), TOKEN)).json()).toMatchObject({
    error: 'invalid_grant',
  });
}

async function stampsMcpProjectGrantProjectURLA2aAgent() {
  const mcpOut = await send(
    tokenRequest({ grant_type: 'client_credentials' }, basic(fixture.mcp.id, fixture.secret)),
    TOKEN,
  );
  expect(mcpOut.response.status).toBe(200);
  await issueTokens();
  const resources = new Map(
    fixture.rows.filter((r) => r.kind === 'access').map((r) => [r.clientId, r.resource]),
  );
  expect(resources.get(fixture.mcp.id)).toBe(MCP_RESOURCE);
  expect(resources.get(fixture.a2a.id)).toBe(A2A_RESOURCE);
}
