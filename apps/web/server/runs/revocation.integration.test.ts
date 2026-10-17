import { afterEach, describe, expect, it } from 'vitest';

import { createGatewayApplication } from '@agent-workspace/gateway';
import { createRunTokenCodec } from '@agent-workspace/gateway/tokens';

import { POST as revokeTokensRoute } from '../../app/api/runs/[id]/revoke-tokens/route';
import { POST as legacyRevokeRoute } from '../../app/api/runs/[id]/route';
import { revokeRunTokens } from './api';
import { installRunApi, resetRunApi } from './environment';
import { InMemoryRunStore } from './store';

const SECRET = 'revocation-integration-secret-at-least-32-bytes';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const OTHER_WORKSPACE = '77777777-7777-4777-8777-777777777777';
const USER = '66666666-6666-4666-8666-666666666666';
const AGENT = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const RUN = '11111111-1111-4111-8111-111111111111';

afterEach(resetRunApi);

describe('run-token revocation edge to gateway', () => {
  it('lets an owner revoke one token and makes the next gateway request reject it', async () => {
    const store = new InMemoryRunStore();
    await store.create({
      engine: 'claude-agent-sdk',
      id: RUN,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      sessionId: SESSION,
    });
    const codec = createRunTokenCodec({ secret: SECRET });
    const token = await codec.issue({
      runId: RUN,
      sessionId: SESSION,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      modelConnectionId: '55555555-5555-4555-8555-555555555555',
    });
    const verified = await codec.verify(token);
    if (!verified.ok) throw new Error('fixture token did not verify');
    const revoked = new Set<string>();
    const gateway = createGatewayApplication({
      tokenSecret: SECRET,
      providers: { fetch: () => Promise.resolve(Response.json({ ok: true })) },
      resolver: {
        resolve: (claims) =>
          Promise.resolve(
            revoked.has(claims.tokenId)
              ? { state: 'revoked' as const }
              : {
                  state: 'active' as const,
                  providerId: 'openai',
                  connectionProvider: 'openai' as const,
                  credential: 'fixture-provider-secret',
                  settings: { baseUrl: 'http://localhost:9999/v1' },
                },
          ),
      },
    });
    installRunApi({
      store,
      authenticate: () =>
        Promise.resolve({
          principalId: USER,
          ownerPrincipalId: USER,
          userId: USER,
          workspaceId: WORKSPACE,
          role: 'owner',
          scope: null,
        }),
      findAgent: () => Promise.resolve(null),
      openSession: () => Promise.resolve(null),
      ownsRun: () => Promise.resolve(true),
      launch: () => undefined,
      revokeRunTokens: (_principal, _runId, tokenId) => {
        if (tokenId !== null) revoked.add(tokenId);
        return Promise.resolve({ revoked: tokenId === null ? 0 : 1, outcome: 'revoked' });
      },
    });

    const modelRequest = () =>
      gateway.fetch(
        new Request('http://gateway/v1/messages', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ model: 'fixture', max_tokens: 8, messages: [] }),
        }),
      );
    expect((await modelRequest()).status).toBe(200);

    const response = await revokeRunTokens(
      new Request(`http://control/api/runs/${RUN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tokenId: verified.claims.tokenId }),
      }),
      RUN,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revoked: 1, outcome: 'revoked' });

    const rejected = await modelRequest();
    expect(rejected.status).toBe(401);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: 'token_revoked' },
    });
  });

  it('refuses revocation from a builder before calling the repository', async () => {
    const store = new InMemoryRunStore();
    await store.create({
      engine: 'claude-agent-sdk',
      id: RUN,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      sessionId: SESSION,
    });
    let calls = 0;
    installRunApi({
      store,
      authenticate: () =>
        Promise.resolve({
          principalId: USER,
          ownerPrincipalId: USER,
          userId: USER,
          workspaceId: WORKSPACE,
          role: 'builder',
          scope: null,
        }),
      findAgent: () => Promise.resolve(null),
      openSession: () => Promise.resolve(null),
      ownsRun: () => Promise.resolve(true),
      launch: () => undefined,
      revokeRunTokens: () => {
        calls += 1;
        return Promise.resolve({ revoked: 1, outcome: 'revoked' });
      },
    });

    const response = await revokeRunTokens(
      new Request(`http://control/api/runs/${RUN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      RUN,
    );
    expect(response.status).toBe(403);
    expect(calls).toBe(0);
  });

  /**
   * The deprecation window's contract: one handler, two paths, one answer — the refusals included.
   * A caller migrating off `POST /api/runs/:id` keeps handling `403`, `404` and `400` as well as
   * the success, and each adapter carries its own `errorResponse` boundary, so a thrown failure is
   * the case where the two could realistically drift.
   */
  it.each([
    {
      name: 'an owner revoking every token of the run',
      role: 'owner',
      runWorkspaceId: WORKSPACE,
      body: '{}',
      status: 200,
      code: null,
    },
    {
      name: 'an admin revoking every token of the run',
      role: 'admin',
      runWorkspaceId: WORKSPACE,
      body: '{}',
      status: 200,
      code: null,
    },
    {
      name: 'a builder',
      role: 'builder',
      runWorkspaceId: WORKSPACE,
      body: '{}',
      status: 403,
      code: 'run_token_revoke_forbidden',
    },
    {
      name: 'a run in another workspace',
      role: 'owner',
      runWorkspaceId: OTHER_WORKSPACE,
      body: '{}',
      status: 404,
      code: 'run_not_found',
    },
    {
      name: 'a tokenId that is not a UUID',
      role: 'owner',
      runWorkspaceId: WORKSPACE,
      body: '{"tokenId":"not-a-uuid"}',
      status: 400,
      code: 'invalid_token_id',
    },
  ] as const)(
    'answers identically on the deprecated path and the named POST /api/runs/:id/revoke-tokens, for $name (issue #235, S-15)',
    async ({ role, runWorkspaceId, body, status, code }) => {
      const store = new InMemoryRunStore();
      await store.create({
        engine: 'claude-agent-sdk',
        id: RUN,
        workspaceId: runWorkspaceId,
        agentId: AGENT,
        sessionId: SESSION,
      });
      installRunApi({
        store,
        authenticate: () =>
          Promise.resolve({
            principalId: USER,
            ownerPrincipalId: USER,
            userId: USER,
            workspaceId: WORKSPACE,
            role,
            scope: null,
          }),
        findAgent: () => Promise.resolve(null),
        openSession: () => Promise.resolve(null),
        ownsRun: () => Promise.resolve(true),
        launch: () => undefined,
        revokeRunTokens: (_principal, _runId, tokenId) =>
          Promise.resolve({ revoked: tokenId === null ? 3 : 1, outcome: 'revoked' }),
      });

      const requestFor = (path: string): Request =>
        new Request(`http://control${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
      const context = { params: Promise.resolve({ id: RUN }) };

      const legacy = await legacyRevokeRoute(requestFor(`/api/runs/${RUN}`) as never, context);
      const named = await revokeTokensRoute(
        requestFor(`/api/runs/${RUN}/revoke-tokens`) as never,
        context,
      );
      expect(named.status).toBe(legacy.status);
      const legacyBody: unknown = await legacy.json();
      const namedBody: unknown = await named.json();
      expect(namedBody).toEqual(legacyBody);

      // Pinned against the expected answer too, so "identical" cannot be satisfied by both paths
      // drifting the same way.
      expect(named.status).toBe(status);
      if (code === null) {
        expect(namedBody).toEqual({ revoked: 3, outcome: 'revoked' });
      } else {
        expect(namedBody).toMatchObject({ error: { code } });
      }
    },
  );
});
