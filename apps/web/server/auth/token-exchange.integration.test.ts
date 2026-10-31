/**
 * ADR-0161 end to end against PostgreSQL: a sample app backend exchanges a person's ID token at
 * the real handler, then calls the real route files through the real edge (`proxy()`) and the
 * production composition (`register()`) with the token it got.
 *
 * What it proves that `token-exchange.test.ts` cannot: the token row and its one audit row are
 * written together, the token resolves through `resolveActor` to the person, a run it starts on a
 * bound agent the person may run carries the person as `initiatingUserId`, a bound agent the
 * person has no grant to is refused, the token lapses 300 seconds after issue and dies with its
 * client. The issuer is a local key pair behind a stub key source; nothing reaches the network.
 *
 * The run API the composition installed is kept whole except `launch`, which settles the run
 * in-process, as `composition/api-key-quickstart.integration.test.ts` does.
 */
import crypto from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { and, eq } from 'drizzle-orm';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import {
  agentGrants,
  apiKeys,
  auditEvents,
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  memberships,
  runtimeProfiles,
  userIdentities,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import {
  ID_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
  TokenExchangeResponseSchema,
} from '@indx-workspace/contracts/token-exchange';

import { POST as startRunRoute } from '../../app/api/agents/[id]/runs/route';
import { POST as createAgentRoute } from '../../app/api/agents/route';
import { GET as meRoute } from '../../app/api/me/route';
import { GET as readRunRoute } from '../../app/api/runs/[id]/route';
import { GET as listWorkspacesRoute } from '../../app/api/workspaces/route';
import { proxy } from '../../proxy';
import { applicationContext } from '../application-context';
import { installTestRunApi } from '../application-context-fixtures';
import type { RegisteredComposition } from '../composition/register';
import { resetOAuthLimits } from '../oauth/limits';
import { mintClientSecret } from '../oauth/tokens';
import { mintApiKey } from '../rbac/api-key';
import { toResponse } from '../rbac/http';
import { getRunApi } from '../runs/environment';
import { exchangeToken, resetTokenExchangeLimits, type IdTokenKeySource } from './token-exchange';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

if (!hasDatabase) {
  console.warn(
    '[auth/token-exchange.integration.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the ' +
      'ID-token exchange was NOT exercised against PostgreSQL.',
  );
}

const CONTROLLED_ENV = [
  'AW_STORAGE_URL',
  'AW_RUNTIME_VERIFICATION_FILE',
  'DATABASE_URL',
  'GATEWAY_TOKEN_SECRET',
  'MASTER_ENCRYPTION_KEY',
  'NEXT_RUNTIME',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_ISSUER_URL',
  'OIDC_REDIRECT_URI',
  'RUNNER_MANAGER_TOKEN',
  'RUNNER_MANAGER_URL',
  'RUNNER_URL',
  'SESSION_SECRET',
] as const;

const BASE_URL = 'http://127.0.0.1:3000';
const PASSED_THROUGH = 'x-middleware-next';
const ISSUER = 'https://idp.example';
const AUDIENCE = 'portal-web';
const AGENT_MODEL = 'claude-sonnet-4-5';

type RouteHandler = (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) => Promise<Response>;

const ROUTES: readonly { method: string; pattern: RegExp; handler: RouteHandler }[] = [
  { method: 'POST', pattern: /^\/api\/agents$/u, handler: createAgentRoute },
  { method: 'POST', pattern: /^\/api\/agents\/([^/]+)\/runs$/u, handler: startRunRoute },
  { method: 'GET', pattern: /^\/api\/runs\/([^/]+)$/u, handler: readRunRoute },
  { method: 'GET', pattern: /^\/api\/me$/u, handler: (request) => meRoute(request) },
  {
    method: 'GET',
    pattern: /^\/api\/workspaces$/u,
    handler: (request) => listWorkspacesRoute(request),
  },
];

/** Edge first, then the route file — or the edge's own refusal, exactly as Next serves it. */
async function serve(
  method: string,
  pathname: string,
  bearer: string,
  body?: unknown,
): Promise<Response> {
  const request = new NextRequest(`${BASE_URL}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const gated = await proxy(request);
  if (gated.headers.get(PASSED_THROUGH) !== '1') return gated;
  for (const route of ROUTES) {
    const match = route.method === method ? route.pattern.exec(pathname) : null;
    if (match === null) continue;
    return route.handler(request, { params: Promise.resolve({ id: match[1] ?? '' }) });
  }
  throw new Error(`the harness has no route for ${method} ${pathname}`);
}

async function startModelListServer(): Promise<{ readonly server: Server; readonly url: string }> {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/v1/models') === true) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          data: [
            {
              id: AGENT_MODEL,
              type: 'model',
              display_name: 'Claude Sonnet 4.5',
              created_at: '2025-09-29T00:00:00Z',
            },
          ],
          has_more: false,
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${String(port)}` };
}

describe.skipIf(!hasDatabase)('a sample app backend acting as a person (ADR-0161)', () => {
  let isolated: IsolatedTestDatabase | undefined;
  let root: DatabaseRoot | undefined;
  let composition: RegisteredComposition | undefined;
  let modelListServer: Server | undefined;
  const previousEnv = new Map<string, string | undefined>();
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const ownerUserId = crypto.randomUUID();
  const personUserId = crypto.randomUUID();
  const strangerUserId = crypto.randomUUID();
  let ownerPrincipalId = '';
  let grantedAgent = '';
  let ungrantedAgent = '';
  let unboundAgent = '';
  let clientId = '';
  let clientSecret = '';
  let source: IdTokenKeySource;
  let signingKey: CryptoKey;

  async function idToken(subject: string, claims: Record<string, unknown> = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: ISSUER,
      sub: subject,
      aud: AUDIENCE,
      iat: now - 5,
      exp: now + 600,
      email_verified: true,
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .sign(signingKey);
  }

  async function exchange(token: string): Promise<Response> {
    return toResponse(
      await exchangeToken(
        new Request(`${BASE_URL}/api/auth/token-exchange`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
          },
          body: JSON.stringify({
            grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
            subject_token: token,
            subject_token_type: ID_TOKEN_TYPE,
          }),
        }),
        { loadKeySource: () => Promise.resolve(source) },
      ),
    );
  }

  async function accessToken(subject = 'person-sub'): Promise<string> {
    const response = await exchange(await idToken(subject));
    expect(response.status).toBe(200);
    return TokenExchangeResponseSchema.parse(await response.json()).access_token;
  }

  async function exchangeAudits(): Promise<(typeof auditEvents.$inferSelect)[]> {
    if (isolated === undefined) throw new Error('no database');
    return isolated.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, workspaceId),
          eq(auditEvents.action, 'user-token-exchanged'),
        ),
      );
  }

  beforeAll(async () => {
    for (const name of CONTROLLED_ENV) previousEnv.set(name, process.env[name]);
    const db = await createIsolatedTestDatabase('aw_token_exchange');
    isolated = db;
    await db.db.insert(workspaces).values([
      { id: workspaceId, slug: 'portal-home', name: 'Portal home' },
      { id: otherWorkspaceId, slug: 'elsewhere', name: 'Elsewhere' },
    ]);
    await db.db.insert(users).values([
      { id: ownerUserId, email: 'owner@portal.test', name: 'Owner' },
      { id: personUserId, email: 'ada@portal.test', name: 'Ada' },
      { id: strangerUserId, email: 'bo@elsewhere.test', name: 'Bo' },
    ]);
    await db.db.transaction(async (tx) => {
      for (const [userId, wsId, role] of [
        [ownerUserId, workspaceId, 'owner'],
        [personUserId, workspaceId, 'viewer'],
        [strangerUserId, otherWorkspaceId, 'owner'],
      ] as const) {
        const membershipId = crypto.randomUUID();
        await tx.insert(memberships).values({ id: membershipId, workspaceId: wsId, userId, role });
        const [principal] = await tx
          .insert(workspacePrincipals)
          .values({ workspaceId: wsId, kind: 'membership', membershipId })
          .returning({ id: workspacePrincipals.id });
        if (principal === undefined) throw new Error('fixture: no principal');
        if (userId === ownerUserId) ownerPrincipalId = principal.id;
      }
    });
    await db.db.insert(userIdentities).values([
      { issuer: ISSUER, subject: 'person-sub', userId: personUserId },
      { issuer: ISSUER, subject: 'stranger-sub', userId: strangerUserId },
    ]);
    const ownerKey = await mintApiKey();
    await db.db.insert(apiKeys).values({
      workspaceId,
      name: 'fixture-owner',
      role: 'owner',
      keyPrefix: ownerKey.keyPrefix,
      keyHash: ownerKey.keyHash,
    });

    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'token-exchange-integration-secret-at-least-32-characters';
    process.env['MASTER_ENCRYPTION_KEY'] = crypto.randomBytes(32).toString('hex');
    process.env['RUNNER_URL'] = 'http://127.0.0.1:9';
    process.env['OIDC_ISSUER_URL'] = ISSUER;
    process.env['OIDC_CLIENT_ID'] = 'platform-browser';
    process.env['OIDC_CLIENT_SECRET'] = 'platform-browser-secret';
    process.env['OIDC_REDIRECT_URI'] = `${BASE_URL}/api/auth/callback`;
    for (const name of [
      'AW_STORAGE_URL',
      'AW_RUNTIME_VERIFICATION_FILE',
      'GATEWAY_TOKEN_SECRET',
      'NEXT_RUNTIME',
      'RUNNER_MANAGER_TOKEN',
      'RUNNER_MANAGER_URL',
    ] as const) {
      delete process.env[name];
    }
    const { register } = await import('../composition/register');
    composition = await register();
    if (composition === undefined) throw new Error('composition registration was skipped');
    root = await openDatabaseRoot({ DATABASE_URL: db.url });

    const modelList = await startModelListServer();
    modelListServer = modelList.server;
    const models = applicationContext()?.models;
    if (models?.kind !== 'serving') throw new Error('the composition installed no models API');
    const connection = await models.runtime.models.forWorkspace(workspaceId).create({
      name: 'portal-anthropic',
      provider: 'anthropic',
      apiKey: 'sk-ant-portal-fixture',
      config: { baseUrl: modelList.url },
    });
    if (connection.kind !== 'created') throw new Error(`model connection: ${connection.kind}`);
    const [profile] = await db.db
      .insert(runtimeProfiles)
      .values({
        workspaceId,
        name: 'portal-local',
        driver: 'local',
        networkPolicy: 'none',
        filesystem: 'read-only',
      })
      .returning({ id: runtimeProfiles.id });
    if (profile === undefined) throw new Error('the runtime profile was not created');
    const installed = getRunApi();
    if (installed === null) throw new Error('the composition installed no run API');
    const { store } = installed;
    installTestRunApi({
      ...installed,
      launch: ({ run }) => {
        void (async () => {
          await store.markRunning(run.id);
          await store.finish(run.id, 'completed', null, true);
        })();
      },
    });

    const created: string[] = [];
    for (const name of ['Granted', 'Ungranted', 'Unbound']) {
      const response = await serve('POST', '/api/agents', ownerKey.presented, {
        name,
        instructions: 'Answer briefly.',
        model: AGENT_MODEL,
        modelConnectionId: connection.connection.id,
        runtimeProfileId: profile.id,
        permissions: {
          readFiles: true,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
      });
      const text = await response.text();
      if (response.status !== 201) throw new Error(`creating ${name}: ${text}`);
      created.push((JSON.parse(text) as { id: string }).id);
    }
    [grantedAgent = '', ungrantedAgent = '', unboundAgent = ''] = created;
    // The person may run the granted agent and the unbound one; the client binds the first two.
    await db.db.insert(agentGrants).values([
      { workspaceId, agentId: grantedAgent, userId: personUserId },
      { workspaceId, agentId: unboundAgent, userId: personUserId },
    ]);

    const scope = await root.scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('workspace did not resolve');
    const clients = root.endpointClients.forScope(scope);
    const client = await clients.create({
      name: 'portal',
      kind: 'app-backend',
      agentIds: [grantedAgent, ungrantedAgent],
      oidcAudience: AUDIENCE,
      actsForPrincipalId: ownerPrincipalId,
      createdByPrincipalId: ownerPrincipalId,
    });
    if (client.kind !== 'created') throw new Error('fixture: client creation failed');
    clientId = client.client.id;
    const minted = await mintClientSecret();
    clientSecret = minted.presented;
    await clients.setSecretHash(clientId, minted.secretHash, new Date());

    const pair = await generateKeyPair('RS256', { extractable: true });
    signingKey = pair.privateKey;
    source = {
      issuer: ISSUER,
      algorithms: ['RS256'],
      keys: createLocalJWKSet({
        keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' }],
      }),
    };
  }, 180_000);

  afterEach(() => {
    vi.useRealTimers();
    resetTokenExchangeLimits();
    resetOAuthLimits();
  });

  afterAll(async () => {
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (modelListServer !== undefined) {
      const server = modelListServer;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await root?.close();
    if (isolated !== undefined) {
      await closeIsolatedTestResources(
        isolated,
        ...(composition === undefined ? [] : [composition]),
      );
    }
  });

  it('writes one user-token-exchanged row per exchange, with the person acting on the client', async () => {
    const before = (await exchangeAudits()).length;
    await accessToken();
    const rows = await exchangeAudits();
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({
      actorUserId: personUserId,
      actorLabel: expect.any(String) as unknown,
      subjectId: clientId,
      subjectLabel: 'portal',
      details: null,
    });
  }, 60_000);

  it('writes no row for a refusal: a stranger, a wrong audience, a wrong issuer', async () => {
    const before = (await exchangeAudits()).length;
    for (const [token, status, code] of [
      [await idToken('stranger-sub'), 403, 'subject_not_member'],
      [await idToken('nobody-sub'), 403, 'subject_not_member'],
      [await idToken('person-sub', { aud: 'another-app' }), 401, 'subject_token_wrong_audience'],
      [
        await idToken('person-sub', { iss: 'https://evil.example' }),
        401,
        'subject_token_wrong_issuer',
      ],
      [await idToken('person-sub', { email_verified: false }), 401, 'subject_token_invalid'],
    ] as const) {
      const response = await exchange(token);
      expect(response.status, code).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
    }
    expect(await exchangeAudits()).toHaveLength(before);
  }, 60_000);

  it('starts a run as the person on a bound agent they may run, and reads it back', async () => {
    const token = await accessToken();
    const me = await serve('GET', '/api/me', token);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      kind: 'membership',
      role: 'viewer',
      workspaceId,
      userId: personUserId,
    });

    const started = await serve('POST', `/api/agents/${grantedAgent}/runs`, token, {
      prompt: 'Hello.',
    });
    const text = await started.text();
    expect(started.status, text).toBe(202);
    const runId = (JSON.parse(text) as { run: { id: string } }).run.id;
    const read = await serve('GET', `/api/runs/${runId}`, token);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      run: { id: runId, agentId: grantedAgent, initiatingUserId: personUserId },
    });
  }, 60_000);

  it('is refused for a bound agent the person has no grant to, and for an unbound one', async () => {
    const token = await accessToken();
    const ungranted = await serve('POST', `/api/agents/${ungrantedAgent}/runs`, token, {
      prompt: 'Hello.',
    });
    expect(ungranted.status).toBe(403);
    const unbound = await serve('POST', `/api/agents/${unboundAgent}/runs`, token, {
      prompt: 'Hello.',
    });
    expect(unbound.status).toBe(403);
    expect(await unbound.json()).toMatchObject({ error: { code: 'token_out_of_scope' } });
  }, 60_000);

  it('is not admitted on a route outside the app-backend grammar (ADR-0161 D8, D9)', async () => {
    // The wire answer is 401 at admission; decide()'s 403 token_out_of_scope for the same routes is
    // the second layer, proven in token-exchange.test.ts.
    const token = await accessToken();
    expect((await serve('GET', '/api/workspaces', token)).status).toBe(401);
    expect((await serve('POST', '/api/files', token, {})).status).toBe(401);
  }, 60_000);

  it('answers 401 once 300 seconds have passed since issue', async () => {
    const token = await accessToken();
    expect((await serve('GET', '/api/me', token)).status).toBe(200);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 299_000);
    expect((await serve('GET', '/api/me', token)).status).toBe(200);
    vi.setSystemTime(Date.now() + 2_000);
    expect((await serve('GET', '/api/me', token)).status).toBe(401);
  }, 60_000);

  it('dies with its client: revoking the client kills the token at once', async () => {
    const token = await accessToken();
    expect((await serve('GET', '/api/me', token)).status).toBe(200);
    if (root === undefined) throw new Error('no database root');
    const scope = await root.scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('workspace did not resolve');
    await root.endpointClients.forScope(scope).revoke(clientId, new Date());
    expect((await serve('GET', '/api/me', token)).status).toBe(401);
    const again = await exchange(await idToken('person-sub'));
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ error: { code: 'invalid_client' } });
  }, 60_000);
});
