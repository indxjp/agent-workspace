import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as REVOKE } from '../../app/oauth/revoke/route';
import { POST as TOKEN } from '../../app/oauth/token/route';
import { installTestDomains } from '../application-context-fixtures';
import { callerHeaders, TEST_WORKSPACE_ID } from '../rbac/testing';
import { captureLog } from '../telemetry/capture-log';
import { log as webLogger } from '../telemetry/logger';
import type { ToolEndpointEnvironment } from '../tool-endpoint/env';
import {
  approvedCode,
  authorizeParams,
  authorizePost,
  basic,
  codeGrant,
  fixture,
  issueTokens,
  ORIGIN,
  send,
  tokenRequest,
  viewerCaller,
} from './oauth-server.test-support';

const install = (closeSandbox: ToolEndpointEnvironment['closeSandbox']): void =>
  installTestDomains({
    toolEndpoint: { kind: 'serving', environment: { closeSandbox } as ToolEndpointEnvironment },
  });

const asProject = (): void => {
  fixture.clients.set(fixture.a2a.id, { ...fixture.a2a, kind: 'mcp-project' });
};

const refreshGrant = (refresh: string): Record<string, string> => ({
  grant_type: 'refresh_token',
  client_id: fixture.a2a.id,
  refresh_token: refresh,
});

let closed: [string, string][];

describe('POST /oauth/revoke', () => {
  it(
    'revokes an access token alone and answers an empty 200',
    revokesAccessTokenAloneAnswersEmpty200,
  );

  it(
    'revokes the whole family when the token is a refresh token',
    revokesWholeFamilyWhenTokenIsRefreshToken,
  );

  it(
    'audits the revocation as the consenting member, not the client creator',
    auditsRevocationConsentingMemberNotClientCreator,
  );

  it(
    'audits a repeated revocation once and still answers 200',
    auditsRepeatedRevocationOnceStillAnswers200,
  );

  it(
    'audits two concurrent revocations of one token once and answers both 200',
    auditsTwoConcurrentRevocationsOneTokenOnceAnswers,
  );

  it(
    'answers 200 for an unknown token without revoking or auditing anything',
    answers200UnknownTokenWithoutRevokingAuditingAnything,
  );

  it('does not revoke another client’s token', doesNotRevokeAnotherClientSToken);

  it(
    'refuses bad client credentials, and a request without a token',
    refusesBadClientCredentialsRequestWithoutToken,
  );
});

describe('revoking a project client grant closes its tool sandbox', () => {
  beforeEach(() => {
    closed = [];
    install((workspaceId, clientId) => {
      closed.push([workspaceId, clientId]);
      return Promise.resolve();
    });
  });

  it('closes after an access token is revoked', closesAfterAccessTokenIsRevoked);

  it('closes after a refresh token is revoked', closesAfterRefreshTokenIsRevoked);

  it(
    'closes when a replayed refresh token revokes the family',
    closesWhenReplayedRefreshTokenRevokesFamily,
  );

  it('does not close for an a2a-agent client', doesNotCloseA2aAgentClient);

  it(
    'answers an unknown token like a known one and closes nothing',
    answersUnknownTokenLikeKnownOneClosesNothing,
  );

  it('still answers 200 when the close fails', stillAnswers200WhenCloseFails);
});

describe('secrets and tokens stay out of everything but the issuing response', () => {
  it(
    'writes no credential to a log, an error body or the audit trail',
    writesNoCredentialLogErrorBodyAuditTrail,
  );

  it(
    'never echoes a viewer’s consent: a viewer who can run nothing is refused with no code',
    neverEchoesViewerSConsentViewerWhoCan,
  );
});

async function revokesAccessTokenAloneAnswersEmpty200() {
  const { access, refresh } = await issueTokens();
  const out = await send(
    tokenRequest({ client_id: fixture.a2a.id, token: access }, {}, '/oauth/revoke'),
    REVOKE,
  );
  expect(out.response.status).toBe(200);
  expect(out.text).toBe('');
  const states = new Map(
    fixture.rows.filter((r) => r.kind !== 'code').map((r) => [r.kind, r.revokedAt !== null]),
  );
  expect(states.get('access')).toBe(true);
  expect(states.get('refresh')).toBe(false);
  expect(fixture.audits.at(-1)).toMatchObject({
    actor: fixture.ownerId,
    event: { action: 'oauth-grant-revoked', clientId: fixture.a2a.id, detail: 'access' },
  });
  expect(refresh).toBeTruthy();
}

async function revokesWholeFamilyWhenTokenIsRefreshToken() {
  const { refresh } = await issueTokens();
  await send(
    tokenRequest({ client_id: fixture.a2a.id, token: refresh }, {}, '/oauth/revoke'),
    REVOKE,
  );
  expect(fixture.rows.every((r) => r.revokedAt !== null)).toBe(true);
  expect(fixture.audits.at(-1)?.event.detail).toBe('refresh');
}

async function auditsRevocationConsentingMemberNotClientCreator() {
  fixture.clients.set(fixture.a2a.id, { ...fixture.a2a, actsForPrincipalId: fixture.viewerId });
  const { access } = await issueTokens();
  await send(
    tokenRequest({ client_id: fixture.a2a.id, token: access }, {}, '/oauth/revoke'),
    REVOKE,
  );
  expect(fixture.audits.at(-1)).toMatchObject({
    actor: fixture.ownerId,
    event: { action: 'oauth-grant-revoked', detail: 'access' },
  });
}

async function auditsRepeatedRevocationOnceStillAnswers200() {
  const { refresh } = await issueTokens();
  const before = fixture.audits.length;
  for (let i = 0; i < 2; i += 1) {
    const out = await send(
      tokenRequest({ client_id: fixture.a2a.id, token: refresh }, {}, '/oauth/revoke'),
      REVOKE,
    );
    expect(out.response.status).toBe(200);
  }
  expect(fixture.audits.slice(before).map((a) => a.event.action)).toEqual(['oauth-grant-revoked']);
}

async function auditsTwoConcurrentRevocationsOneTokenOnceAnswers() {
  const { access } = await issueTokens();
  const before = fixture.audits.length;
  const outs = await Promise.all(
    [0, 1].map(() =>
      send(tokenRequest({ client_id: fixture.a2a.id, token: access }, {}, '/oauth/revoke'), REVOKE),
    ),
  );
  expect(outs.map((o) => o.response.status)).toEqual([200, 200]);
  expect(fixture.audits.slice(before).map((a) => a.event.action)).toEqual(['oauth-grant-revoked']);
}

async function answers200UnknownTokenWithoutRevokingAuditingAnything() {
  const { access } = await issueTokens();
  const before = fixture.audits.length;
  const unknown = await send(
    tokenRequest({ client_id: fixture.a2a.id, token: 'awo_live_nothing' }, {}, '/oauth/revoke'),
    REVOKE,
  );
  expect(unknown.response.status).toBe(200);
  expect(fixture.audits).toHaveLength(before);
  expect(fixture.rows.some((r) => r.revokedAt !== null)).toBe(false);
  expect(access).toBeTruthy();
}

async function doesNotRevokeAnotherClientSToken() {
  const { access } = await issueTokens();
  const out = await send(
    tokenRequest({ token: access }, basic(fixture.mcp.id, fixture.secret), '/oauth/revoke'),
    REVOKE,
  );
  expect(out.response.status).toBe(200);
  expect(fixture.rows.some((r) => r.revokedAt !== null)).toBe(false);
}

async function refusesBadClientCredentialsRequestWithoutToken() {
  const { access } = await issueTokens();
  const bad = await send(
    tokenRequest({ token: access }, basic(fixture.mcp.id, 'awcs_live_nope'), '/oauth/revoke'),
    REVOKE,
  );
  expect(bad.response.status).toBe(401);
  const empty = await send(
    tokenRequest({ client_id: fixture.a2a.id }, {}, '/oauth/revoke'),
    REVOKE,
  );
  expect(empty.response.status).toBe(400);
}

async function writesNoCredentialLogErrorBodyAuditTrail() {
  const capture = captureLog();
  try {
    const code = await approvedCode();
    const issued = await send(tokenRequest(codeGrant(code)), TOKEN);
    const { access_token: access, refresh_token: refresh } = issued.json() as Record<
      string,
      string
    >;
    await send(tokenRequest(codeGrant(code)), TOKEN);
    await send(
      tokenRequest({ grant_type: 'client_credentials' }, basic(fixture.mcp.id, 'awcs_live_nope')),
      TOKEN,
    );
    await send(
      tokenRequest({ token: access ?? '', client_id: fixture.a2a.id }, {}, '/oauth/revoke'),
      REVOKE,
    );
    await send(
      tokenRequest({ token: refresh ?? '', client_id: fixture.a2a.id }, {}, '/oauth/revoke'),
      REVOKE,
    );

    const credentials = [code, access, refresh, fixture.secret].filter(
      (v): v is string => typeof v === 'string',
    );
    const others = fixture.bodies.filter((b) => b !== issued.text);
    const logs = capture.text();
    for (const credential of credentials) {
      expect(logs).not.toContain(credential);
      expect(JSON.stringify(fixture.audits)).not.toContain(credential);
      for (const body of others) {
        // The consent redirect carries the code in a header, not a body.
        expect(body).not.toContain(credential);
      }
    }
    expect(issued.text).toContain(String(access));
  } finally {
    capture.restore();
  }
}

async function neverEchoesViewerSConsentViewerWhoCan() {
  fixture.cannotRun.add(fixture.viewerId);
  const { response } = await authorizePost(
    { ...authorizeParams(), decision: 'approve' },
    { origin: ORIGIN, ...callerHeaders(viewerCaller) },
  );
  expect(new URL(response.headers.get('location') ?? '').searchParams.get('error')).toBe(
    'access_denied',
  );
  expect(fixture.rows).toEqual([]);
}

async function stillAnswers200WhenCloseFails() {
  asProject();
  install(() => Promise.reject(new Error('manager down')));
  vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
  const { access } = await issueTokens();
  const out = await send(
    tokenRequest({ client_id: fixture.a2a.id, token: access }, {}, '/oauth/revoke'),
    REVOKE,
  );
  expect(out.response.status).toBe(200);
}

async function closesAfterAccessTokenIsRevoked() {
  asProject();
  const { access } = await issueTokens();
  await send(
    tokenRequest({ client_id: fixture.a2a.id, token: access }, {}, '/oauth/revoke'),
    REVOKE,
  );
  expect(closed).toEqual([[TEST_WORKSPACE_ID, fixture.a2a.id]]);
}

async function closesAfterRefreshTokenIsRevoked() {
  asProject();
  const { refresh } = await issueTokens();
  await send(
    tokenRequest({ client_id: fixture.a2a.id, token: refresh }, {}, '/oauth/revoke'),
    REVOKE,
  );
  expect(closed).toEqual([[TEST_WORKSPACE_ID, fixture.a2a.id]]);
}

async function closesWhenReplayedRefreshTokenRevokesFamily() {
  asProject();
  const { refresh } = await issueTokens();
  await send(tokenRequest(refreshGrant(refresh)), TOKEN);
  expect(closed).toEqual([]);
  await send(tokenRequest(refreshGrant(refresh)), TOKEN);
  expect(closed).toEqual([[TEST_WORKSPACE_ID, fixture.a2a.id]]);
}

async function doesNotCloseA2aAgentClient() {
  const { access, refresh } = await issueTokens();
  await send(
    tokenRequest({ client_id: fixture.a2a.id, token: access }, {}, '/oauth/revoke'),
    REVOKE,
  );
  await send(tokenRequest(refreshGrant(refresh)), TOKEN);
  await send(tokenRequest(refreshGrant(refresh)), TOKEN);
  expect(closed).toEqual([]);
}

async function answersUnknownTokenLikeKnownOneClosesNothing() {
  asProject();
  const unknown = await send(
    tokenRequest({ client_id: fixture.a2a.id, token: 'awo_live_nothing' }, {}, '/oauth/revoke'),
    REVOKE,
  );
  expect(unknown.response.status).toBe(200);
  expect(unknown.text).toBe('');
  expect(closed).toEqual([]);
}
