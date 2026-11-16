import { describe, expect, it } from 'vitest';
import { POST as TOKEN } from '../../app/oauth/token/route';
import { clearApplicationContext } from '../application-context';
import {
  authorizeGet,
  authorizeParams,
  basic,
  codeGrant,
  fixture,
  ORIGIN,
  OTHER_WORKSPACE,
  ownerCaller,
  send,
  tokenRequest,
} from './oauth-server.test-support';
import { mintClientSecret } from './tokens';

const grant = { grant_type: 'client_credentials' };

describe('client authentication', () => {
  it(
    'answers 503 server_error at /oauth/token and /oauth/authorize while no context is installed',
    answers503ServerErrorAtOauthTokenOauth,
  );

  it(
    'accepts client_secret_basic and client_secret_post',
    acceptsClientSecretBasicClientSecretPost,
  );

  it(
    'answers 401 invalid_client with a Basic challenge for a wrong secret',
    answers401InvalidClientBasicChallengeWrongSecret,
  );

  it(
    'answers the same for an unknown client, a malformed id and a malformed secret',
    answersSameUnknownClientMalformedIdMalformedSecret,
  );

  it(
    'refuses a confidential client that sends no secret',
    refusesConfidentialClientThatSendsNoSecret,
  );

  it('refuses a public client that sends a secret', refusesPublicClientThatSendsSecret);

  it(
    'refuses two authentication methods at once, and a mismatched client_id',
    refusesTwoAuthenticationMethodsAtOnceMismatchedClient,
  );

  it(
    'keeps a client of another workspace in its own workspace: its tokens and audit are scoped there',
    keepsClientAnotherWorkspaceOwnWorkspaceTokensAudit,
  );

  it(
    'refuses a body that is not form-encoded, or repeats a parameter',
    refusesBodyThatIsNotFormEncodedRepeats,
  );

  it(
    'refuses a revoked or deleted client (the runtime finds none)',
    refusesRevokedDeletedClientRuntimeFindsNone,
  );
});

async function refusesPublicClientThatSendsSecret() {
  const out = await send(tokenRequest({ ...codeGrant('x'), client_secret: fixture.secret }), TOKEN);
  expect(out.response.status).toBe(401);
}

async function refusesBodyThatIsNotFormEncodedRepeats() {
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
      body: `grant_type=client_credentials&grant_type=password&client_id=${fixture.mcp.id}`,
    }),
    TOKEN,
  );
  expect(repeated.json()).toMatchObject({ error: 'invalid_request' });
}

async function answers503ServerErrorAtOauthTokenOauth() {
  clearApplicationContext();
  const token = await send(tokenRequest(grant, basic(fixture.mcp.id, fixture.secret)), TOKEN);
  expect(token.response.status).toBe(503);
  expect(token.json()).toMatchObject({ error: 'server_error' });
  const authorize = await authorizeGet(authorizeParams(), ownerCaller);
  expect(authorize.response.status).toBe(503);
}

async function acceptsClientSecretBasicClientSecretPost() {
  expect(
    (await send(tokenRequest(grant, basic(fixture.mcp.id, fixture.secret)), TOKEN)).response.status,
  ).toBe(200);
  expect(
    (
      await send(
        tokenRequest({ ...grant, client_id: fixture.mcp.id, client_secret: fixture.secret }),
        TOKEN,
      )
    ).response.status,
  ).toBe(200);
}

async function answers401InvalidClientBasicChallengeWrongSecret() {
  const wrong = (await mintClientSecret()).presented;
  const out = await send(tokenRequest(grant, basic(fixture.mcp.id, wrong)), TOKEN);
  expect(out.response.status).toBe(401);
  expect(out.response.headers.get('www-authenticate')).toBe('Basic realm="agent-workspace"');
  expect(out.json()).toMatchObject({ error: 'invalid_client' });
}

async function answersSameUnknownClientMalformedIdMalformedSecret() {
  const wrong = await send(tokenRequest(grant, basic(fixture.mcp.id, 'awcs_live_nope')), TOKEN);
  const unknown = await send(
    tokenRequest(grant, basic(crypto.randomUUID(), fixture.secret)),
    TOKEN,
  );
  const malformedId = await send(tokenRequest(grant, basic('not-a-uuid', fixture.secret)), TOKEN);
  for (const out of [wrong, unknown, malformedId]) {
    expect(out.response.status).toBe(401);
    expect(out.text).toBe(wrong.text);
  }
}

async function refusesConfidentialClientThatSendsNoSecret() {
  const out = await send(tokenRequest({ ...grant, client_id: fixture.mcp.id }), TOKEN);
  expect(out.response.status).toBe(401);
}

async function refusesTwoAuthenticationMethodsAtOnceMismatchedClient() {
  const both = await send(
    tokenRequest(
      { ...grant, client_secret: fixture.secret },
      basic(fixture.mcp.id, fixture.secret),
    ),
    TOKEN,
  );
  expect(both.response.status).toBe(400);
  expect(both.json()).toMatchObject({ error: 'invalid_request' });
  const mismatch = await send(
    tokenRequest({ ...grant, client_id: fixture.a2a.id }, basic(fixture.mcp.id, fixture.secret)),
    TOKEN,
  );
  expect(mismatch.response.status).toBe(400);
}

async function keepsClientAnotherWorkspaceOwnWorkspaceTokensAudit() {
  const out = await send(tokenRequest(grant, basic(fixture.foreign.id, fixture.secret)), TOKEN);
  expect(out.response.status).toBe(200);
  expect(fixture.rows[0]).toMatchObject({ clientId: fixture.foreign.id });
  expect(fixture.audits[0]?.workspaceId).toBe(OTHER_WORKSPACE);
}

async function refusesRevokedDeletedClientRuntimeFindsNone() {
  fixture.clients.delete(fixture.mcp.id);
  const out = await send(tokenRequest(grant, basic(fixture.mcp.id, fixture.secret)), TOKEN);
  expect(out.response.status).toBe(401);
}
