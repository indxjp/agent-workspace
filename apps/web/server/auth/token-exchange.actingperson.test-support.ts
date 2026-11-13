import { BASE_URL, ISSUER, AUDIENCE, serve } from './token-exchange.transport.test-support';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { expect, it } from 'vitest';
import {
  ID_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
  TokenExchangeResponseSchema,
} from '@indx-workspace/contracts/token-exchange';
import { toResponse } from '../rbac/http';
import { exchangeToken } from './token-exchange';
import type { TokenExchangeFixture } from './token-exchange.fixture.test-support';

export function registerTokenExchangeActingPersonTests(
  getFixture: () => Pick<
    TokenExchangeFixture,
    | 'accessToken'
    | 'workspaceId'
    | 'personUserId'
    | 'grantedAgent'
    | 'ungrantedAgent'
    | 'unboundAgent'
    | 'root'
    | 'ownerUserId'
    | 'env'
    | 'exchangeAudits'
    | 'clientId'
    | 'clientSecret'
  >,
) {
  it('starts a run as the person on a bound agent they may run, and reads it back', async () => {
    const testContext = getFixture();

    const token = await testContext.accessToken();
    const me = await serve('GET', '/api/me', token);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      kind: 'membership',
      role: 'viewer',
      workspaceId: testContext.workspaceId,
      userId: testContext.personUserId,
    });

    const started = await serve('POST', `/api/agents/${testContext.grantedAgent}/runs`, token, {
      prompt: 'Hello.',
    });
    const text = await started.text();
    expect(started.status, text).toBe(202);
    const runId = (JSON.parse(text) as { run: { id: string } }).run.id;
    const read = await serve('GET', `/api/runs/${runId}`, token);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      run: {
        id: runId,
        agentId: testContext.grantedAgent,
        initiatingUserId: testContext.personUserId,
      },
    });

    // The run list, admitted at the edge and narrowed to the client's agents (the amendment of
    // issue #1530); an agent filter outside them is the scope's refusal.
    const listed = await serve('GET', '/api/runs?limit=50', token);
    expect(listed.status).toBe(200);
    const { runs } = (await listed.json()) as { runs: { id: string; agentId: string }[] };
    expect(runs.map((run) => run.id)).toContain(runId);
    for (const run of runs)
      expect([testContext.grantedAgent, testContext.ungrantedAgent]).toContain(run.agentId);
    const outside = await serve('GET', `/api/runs?agent=${testContext.unboundAgent}`, token);
    expect(outside.status).toBe(403);
    expect(await outside.json()).toMatchObject({ error: { code: 'token_out_of_scope' } });
  }, 60_000);

  it('exchanges an EdDSA ID token from a dev issuer on 127.0.0.1 for the linked Owner, who then starts a run (ADR-0161 amendment, #2075)', async () => {
    const testContext1 = getFixture();

    if (testContext1.root === undefined) throw new Error('no database root');
    // An issuer shaped like aw dev's: http on 127.0.0.1, one Ed25519 key, discovered for real.
    const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'dev-key', alg: 'EdDSA', use: 'sig' };
    const issuerServer = createServer((request, response) => {
      const origin = `http://${request.headers.host ?? ''}`;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify(
          request.url === '/jwks'
            ? { keys: [jwk] }
            : {
                issuer: origin,
                authorization_endpoint: `${origin}/authorize`,
                token_endpoint: `${origin}/token`,
                jwks_uri: `${origin}/jwks`,
                response_types_supported: ['code'],
                subject_types_supported: ['public'],
                id_token_signing_alg_values_supported: ['EdDSA'],
                token_endpoint_auth_methods_supported: ['client_secret_basic'],
              },
        ),
      );
    });
    await new Promise<void>((resolve) => issuerServer.listen(0, '127.0.0.1', resolve));
    const devIssuer = `http://127.0.0.1:${String((issuerServer.address() as AddressInfo).port)}`;
    const ownerEmail = 'owner@portal.test';
    const ownerSubject = `local:${crypto.createHash('sha256').update(ownerEmail).digest('base64url')}`;
    // DI8: the launcher links the bootstrap Owner, idempotently.
    await testContext1.root.directory.linkIdentity(
      devIssuer,
      ownerSubject,
      testContext1.ownerUserId,
    );
    await testContext1.root.directory.linkIdentity(
      devIssuer,
      ownerSubject,
      testContext1.ownerUserId,
    );
    getFixture().env['OIDC_ISSUER_URL'] = devIssuer;
    try {
      const now = Math.floor(Date.now() / 1000);
      const devToken = await new SignJWT({
        iss: devIssuer,
        sub: ownerSubject,
        aud: AUDIENCE,
        azp: AUDIENCE,
        email: ownerEmail,
        email_verified: true,
        iat: now,
        auth_time: now,
        exp: now + 600,
      })
        .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: 'dev-key' })
        .sign(pair.privateKey);
      const before = (await testContext1.exchangeAudits()).length;
      // The production key source: plain http discovery, allowed in the local posture on loopback.
      const exchanged = toResponse(
        await exchangeToken(
          new Request(`${BASE_URL}/api/auth/token-exchange`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Basic ${btoa(`${testContext1.clientId}:${testContext1.clientSecret}`)}`,
            },
            body: JSON.stringify({
              grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
              subject_token: devToken,
              subject_token_type: ID_TOKEN_TYPE,
            }),
          }),
        ),
      );
      const body = await exchanged.text();
      expect(exchanged.status, body).toBe(200);
      const answer = TokenExchangeResponseSchema.parse(JSON.parse(body));
      // ADR-0161 D2 holds on this path: 300 seconds, and one audit row with the client.
      expect(answer.expires_in).toBe(300);
      expect(answer.access_token).toMatch(/^awo_live_/u);
      const rows = await testContext1.exchangeAudits();
      expect(rows).toHaveLength(before + 1);
      expect(rows.at(-1)).toMatchObject({
        actorUserId: testContext1.ownerUserId,
        subjectId: testContext1.clientId,
      });

      const started = await serve(
        'POST',
        `/api/agents/${testContext1.grantedAgent}/runs`,
        answer.access_token,
        {
          prompt: 'Hello.',
        },
      );
      const text = await started.text();
      expect(started.status, text).toBe(202);
      const runId = (JSON.parse(text) as { run: { id: string } }).run.id;
      const read = await serve('GET', `/api/runs/${runId}`, answer.access_token);
      expect(await read.json()).toMatchObject({
        run: {
          id: runId,
          agentId: testContext1.grantedAgent,
          initiatingUserId: testContext1.ownerUserId,
        },
      });
    } finally {
      getFixture().env['OIDC_ISSUER_URL'] = ISSUER;
      await new Promise<void>((resolve) => issuerServer.close(() => resolve()));
    }
  }, 60_000);
}
