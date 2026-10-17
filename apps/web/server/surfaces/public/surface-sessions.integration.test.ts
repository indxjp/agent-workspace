/**
 * The hosted surface page's local session bootstrap **as `register()` composes it** (ADR-0105
 * slice 1; S1-17, issue #455).
 *
 * `handlers.test.ts` proves the order of the answers against a fake runtime. This file proves the
 * PostgreSQL wiring and the token's reach: an agent is created through `POST /api/agents {version}`
 * with a surface `main`, which points `local` at its version 1 (C9); the bootstrap route then
 * resolves that surface in the bootstrap workspace, opens a session as the agent's owner and mints
 * a session-scoped browser token through the real tokens runtime. That token starts a run in its
 * own session and nowhere else (`requireSessionScopeMatch`, `403 token_out_of_scope`), and a
 * refused preflight opens no session at all.
 *
 * The fixture shape is `../../composition/api-key-quickstart.integration.test.ts`'s: a runtime
 * profile and a ready model connection whose model list is a loopback stand-in, so the run
 * preflight passes offline, and a run API whose `launch` settles nothing.
 *
 * S1-24 (issue #509): an agent pushed with the per-run local runtime key is owned by the admin the
 * key acts for, so revoking the key (the stop, or the next start's sweep) leaves its surface open.
 * Before the fix the agent was owned by the key's principal, which stops resolving once the key is
 * revoked, and the bootstrap answered 404 `surface_not_found`.
 *
 * S2-05b (issue #538): surface `main` offers "Billing desk" (the same owner) and "Stranger desk"
 * (another API-key principal's). A resume key resumes exactly its (surface, agent) session, and
 * a switch opens a session as the offered agent's owner; the stranger's agent is never offered.
 */
import crypto, { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  apiKeys,
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  runtimeProfiles,
  sessions,
  surfaceSessionKeys,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { openDatabaseRoot } from '@agent-workspace/core/db';
import { ApiProblemSchema } from '@indx-workspace/contracts';
import {
  SurfaceSessionResponseSchema,
  type SurfaceSessionResponse,
} from '@indx-workspace/contracts/surfaces';

import { POST as startRunRoute } from '../../../app/api/agents/[id]/runs/route';
import { PUT as setPointerRoute } from '../../../app/api/agents/[id]/pointers/route';
import { POST as createVersionRoute } from '../../../app/api/agents/[id]/versions/route';
import { POST as createAgentRoute } from '../../../app/api/agents/route';
import { GET as runEventsRoute } from '../../../app/api/runs/[id]/events/route';
import { GET as readRunRoute } from '../../../app/api/runs/[id]/route';
import { POST as createSurfaceSessionRoute } from '../../../app/p/s/[name]/sessions/route';
import { fixtureSurface, fromVersionRequest } from '../../agent-versions/fixtures';
import { issueLocalApiKey } from '../../cli-auth/local-credential';
import type { RegisteredComposition } from '../../composition/register';
import { currentModelsRuntime } from '../../models/runtime';
import { mintApiKey } from '../../rbac/api-key';
import { getRunApi, installRunApi } from '../../runs/environment';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

if (!hasDatabase) {
  console.warn(
    '[surfaces/public/surface-sessions.integration.test.ts] SKIPPED — TEST_DATABASE_URL is not ' +
      'set, so the surface session bootstrap was NOT exercised against the real composition.',
  );
}

const CONTROLLED_ENV = [
  'AW_FILE_STORAGE_ROOT',
  'AW_LOCAL_SURFACE_SESSIONS',
  'AW_RUNTIME_VERIFICATION_FILE',
  'AW_SKILL_STORAGE_ROOT',
  'BOOTSTRAP_ADMIN',
  'BOOTSTRAP_ADMIN_PASSWORD',
  'DATABASE_URL',
  'GATEWAY_TOKEN_SECRET',
  'HOST',
  'HOSTNAME',
  'MASTER_ENCRYPTION_KEY',
  'NEXT_RUNTIME',
  'OBJECT_STORAGE_BUCKET',
  'RUNNER_MANAGER_TOKEN',
  'RUNNER_MANAGER_URL',
  'RUNNER_URL',
  'SESSION_SECRET',
  'WORKSPACE_SLUG',
] as const;

const WORKSPACE_SLUG = 'surface-sessions';
const ORIGIN = 'http://127.0.0.1:4310';
const AGENT_MODEL = 'claude-sonnet-4-5';
const CONNECTION_NAME = 'surface-anthropic';
const PROFILE_NAME = 'surface-local';
const BILLING = 'Billing desk';
const STRANGER = 'Stranger desk';
const SHOP_ORIGIN = 'https://shop.example.com';

/** A loopback stand-in for Anthropic's `GET /v1/models`, so the preflight's discovery succeeds. */
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

/** A create-from-version body for agent `name` serving surface `surface`, with a model. */
function agentWithSurface(
  name: string,
  surface: string,
  runtimeProfileName: string | null,
  switcher: readonly string[] = [],
  embedding: Readonly<Record<string, unknown>> = {},
): unknown {
  const request = fromVersionRequest({
    name,
    modelConnectionName: CONNECTION_NAME,
    runtimeProfileName,
    surfaces: [
      {
        ...fixtureSurface(surface, name),
        ...(switcher.length === 0 ? {} : { parts: { agentSwitcher: { agents: switcher } } }),
        ...embedding,
      },
    ],
  });
  const { body } = request.version;
  return {
    version: {
      ...request.version,
      body: {
        ...body,
        definition: {
          ...body.definition,
          agent: { ...body.definition.agent, model: AGENT_MODEL },
        },
      },
    },
  };
}

describe.skipIf(!hasDatabase)('the surface session bootstrap through register() (S1-17)', () => {
  let isolated: IsolatedTestDatabase | undefined;
  let composition: RegisteredComposition | undefined;
  let modelListServer: Server | undefined;
  const previousEnv = new Map<string, string | undefined>();
  const workspaceId = crypto.randomUUID();
  let ownerKey = '';
  let ownerPrincipalId = '';
  let agentId = '';
  let billingId = '';
  let shopId = '';
  /** The finish of the last launched run; `startRun` waits for it. */
  let ended: Promise<void> = Promise.resolve();

  function db(): IsolatedTestDatabase {
    if (isolated === undefined) throw new Error('the isolated database was not created');
    return isolated;
  }

  async function sessionCount(): Promise<number> {
    return (
      await db()
        .db.select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.workspaceId, workspaceId))
    ).length;
  }

  /** An owner API key in the workspace: its presented secret and its principal. */
  async function ownerApiKey(name: string): Promise<{ key: string; principalId: string }> {
    const minted = await mintApiKey();
    const apiKeyId = crypto.randomUUID();
    await db().db.insert(apiKeys).values({
      id: apiKeyId,
      workspaceId,
      name,
      role: 'owner',
      keyPrefix: minted.keyPrefix,
      keyHash: minted.keyHash,
    });
    const principal = (await db().db.select().from(workspacePrincipals)).find(
      (candidate) => candidate.apiKeyId === apiKeyId,
    );
    if (principal === undefined) throw new Error('the API-key principal trigger created nothing');
    return { key: minted.presented, principalId: principal.id };
  }

  beforeAll(async () => {
    for (const name of CONTROLLED_ENV) previousEnv.set(name, process.env[name]);
    isolated = await createIsolatedTestDatabase('aw_surface_sessions');
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: WORKSPACE_SLUG, name: 'Surface sessions' });
    const owner = await ownerApiKey('surface-owner');
    ownerKey = owner.key;
    ownerPrincipalId = owner.principalId;
    const stranger = await ownerApiKey('surface-stranger');

    process.env['DATABASE_URL'] = isolated.url;
    process.env['SESSION_SECRET'] = 'surface-sessions-test-secret-at-least-32-characters';
    process.env['MASTER_ENCRYPTION_KEY'] = crypto.randomBytes(32).toString('hex');
    process.env['RUNNER_URL'] = 'http://127.0.0.1:9';
    process.env['BOOTSTRAP_ADMIN'] = 'owner@surface-sessions.test';
    process.env['BOOTSTRAP_ADMIN_PASSWORD'] = 'surface-sessions-password';
    process.env['WORKSPACE_SLUG'] = WORKSPACE_SLUG;
    process.env['AW_LOCAL_SURFACE_SESSIONS'] = '1';
    process.env['HOST'] = '127.0.0.1';
    for (const name of [
      'AW_FILE_STORAGE_ROOT',
      'AW_RUNTIME_VERIFICATION_FILE',
      'AW_SKILL_STORAGE_ROOT',
      'GATEWAY_TOKEN_SECRET',
      'HOSTNAME',
      'NEXT_RUNTIME',
      'OBJECT_STORAGE_BUCKET',
      'RUNNER_MANAGER_TOKEN',
      'RUNNER_MANAGER_URL',
    ] as const) {
      delete process.env[name];
    }
    const { register } = await import('../../composition/register');
    composition = await register();
    if (composition === undefined) throw new Error('composition registration was skipped');

    const modelList = await startModelListServer();
    modelListServer = modelList.server;
    const modelsRuntime = currentModelsRuntime();
    if (modelsRuntime === null) throw new Error('the composition installed no models API');
    const connection = await modelsRuntime.models.forWorkspace(workspaceId).create({
      name: CONNECTION_NAME,
      provider: 'anthropic',
      apiKey: 'sk-ant-surface-fixture',
      config: { baseUrl: modelList.url },
    });
    if (connection.kind !== 'created') throw new Error(`model connection: ${connection.kind}`);
    await isolated.db.insert(runtimeProfiles).values({
      workspaceId,
      name: PROFILE_NAME,
      driver: 'local',
      networkPolicy: 'none',
      filesystem: 'read-only',
    });

    // The installed run API, whole, with a launch that runs nothing and ends the run at once: a
    // session takes one run at a time, so a visitor's next turn needs the last one finished.
    const installed = getRunApi();
    if (installed === null) throw new Error('the composition installed no run API');
    installRunApi({
      ...installed,
      launch: (context) => {
        ended = installed.store.finish(context.run.id, 'completed', null);
      },
    });

    for (const [name, surface, profile, key, switcher] of [
      ['Front desk', 'main', PROFILE_NAME, ownerKey, [BILLING, STRANGER]],
      [BILLING, 'billing', PROFILE_NAME, ownerKey, []],
      [STRANGER, 'stranger', PROFILE_NAME, stranger.key, []],
      ['Unprofiled desk', 'bare', null, ownerKey, []],
    ] as const) {
      const response = await createAgentRoute(
        new Request(`${ORIGIN}/api/agents`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify(agentWithSurface(name, surface, profile, switcher)),
        }),
      );
      const text = await response.text();
      if (response.status !== 201) throw new Error(`creating ${name}: ${text}`);
      const created = (JSON.parse(text) as { agent: { id: string } }).agent.id;
      if (surface === 'main') agentId = created;
      if (surface === 'billing') billingId = created;
    }
    // Issue #622: a surface embedded on a customer's site, one turn per conversation.
    const shop = await createAgentRoute(
      new Request(`${ORIGIN}/api/agents`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(
          agentWithSurface('Shop desk', 'shop', PROFILE_NAME, [], {
            allowedOrigins: [SHOP_ORIGIN],
            limits: { turnsPerConversation: 1 },
          }),
        ),
      }),
    );
    if (shop.status !== 201) throw new Error(`creating Shop desk: ${await shop.text()}`);
    shopId = ((await shop.json()) as { agent: { id: string } }).agent.id;
  }, 180_000);

  afterAll(async () => {
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (modelListServer !== undefined) {
      const server = modelListServer;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (isolated !== undefined) {
      await closeIsolatedTestResources(
        isolated,
        ...(composition === undefined ? [] : [composition]),
      );
    }
  });

  function bootstrap(name: string, options?: unknown): Promise<Response> {
    return createSurfaceSessionRoute(
      new Request(`${ORIGIN}/p/s/${name}/sessions`, {
        method: 'POST',
        headers: { host: '127.0.0.1:4310', origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
        ...(options === undefined ? {} : { body: JSON.stringify(options) }),
      }),
      { params: Promise.resolve({ name }) },
    );
  }

  async function opened(options?: unknown): Promise<SurfaceSessionResponse> {
    const response = await bootstrap('main', options);
    expect(response.status, await response.clone().text()).toBe(201);
    return SurfaceSessionResponseSchema.parse(await response.json());
  }

  function resumeOf(session: SurfaceSessionResponse): { sessionId: string; resumeKey: string } {
    if (session.resumeKey === undefined) throw new Error('a new session carries a resume key');
    return { sessionId: session.sessionId, resumeKey: session.resumeKey };
  }

  async function startRun(token: string, sessionId: string, agent = agentId): Promise<Response> {
    const response = await startRunRoute(
      new NextRequest(`${ORIGIN}/api/agents/${agent}/runs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Where is my order?', sessionId }),
      }),
      { params: Promise.resolve({ id: agent }) },
    );
    await ended;
    return response;
  }

  async function codeOf(response: Response): Promise<string> {
    return ApiProblemSchema.parse(await response.json()).error.code;
  }

  it('opens a session owned by the agent owner and starts a run in it with the token', async () => {
    const response = await bootstrap('main');
    expect(response.status, await response.clone().text()).toBe(201);
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
    const session = SurfaceSessionResponseSchema.parse(await response.json());
    expect(session.agentId).toBe(agentId);

    const [row] = await db().db.select().from(sessions).where(eq(sessions.id, session.sessionId));
    expect(row?.ownerPrincipalId).toBe(ownerPrincipalId);
    expect(row?.agentId).toBe(agentId);

    const started = await startRun(session.token, session.sessionId);
    expect(started.status, await started.clone().text()).toBe(202);
  }, 60_000);

  it('refuses the token in any other session with 403 token_out_of_scope', async () => {
    const first = SurfaceSessionResponseSchema.parse(await (await bootstrap('main')).json());
    const second = SurfaceSessionResponseSchema.parse(await (await bootstrap('main')).json());
    expect(second.sessionId).not.toBe(first.sessionId);

    const crossed = await startRun(first.token, second.sessionId);
    expect(crossed.status).toBe(403);
    await expect(codeOf(crossed)).resolves.toBe('token_out_of_scope');
  }, 60_000);

  it('still opens a session for an agent a since-revoked local runtime key pushed (S1-24)', async () => {
    const root = await openDatabaseRoot({ DATABASE_URL: db().url });
    try {
      const directory = root.directory.forWorkspace(workspaceId);
      const admin = await directory.createUser({
        email: 'admin@surface-sessions.test',
        name: 'Admin',
        role: 'owner',
      });
      if (admin.kind !== 'created') throw new Error(admin.kind);
      const local = await issueLocalApiKey(
        { workspaceId, userId: admin.user.id },
        { directory: root.directory },
      );
      const response = await createAgentRoute(
        new Request(`${ORIGIN}/api/agents`, {
          method: 'POST',
          headers: { authorization: `Bearer ${local.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(agentWithSurface('Local desk', 'desk', PROFILE_NAME)),
        }),
      );
      const text = await response.text();
      expect(response.status, text).toBe(201);
      const created = JSON.parse(text) as { agent: { id: string; ownerPrincipalId: string } };
      expect(created.agent.ownerPrincipalId).toBe(admin.membership.principalId);

      await expect(local.revoke()).resolves.toBe('revoked');
      const opened = await bootstrap('desk');
      expect(opened.status, await opened.clone().text()).toBe(201);
      const session = SurfaceSessionResponseSchema.parse(await opened.json());
      expect(session.agentId).toBe(created.agent.id);
      const [row] = await db().db.select().from(sessions).where(eq(sessions.id, session.sessionId));
      expect(row?.ownerPrincipalId).toBe(admin.membership.principalId);
    } finally {
      await root.close();
    }
  }, 60_000);

  it('answers 404 surface_not_found for a surface nothing serves', async () => {
    const response = await bootstrap('unknown');
    expect(response.status).toBe(404);
    await expect(codeOf(response)).resolves.toBe('surface_not_found');
  }, 60_000);

  it('refuses an agent the preflight refuses with 422, and opens no session', async () => {
    const before = await sessionCount();
    const response = await bootstrap('bare');
    expect(response.status).toBe(422);
    await expect(codeOf(response)).resolves.toBe('agent_runtime_profile_missing');
    expect(await sessionCount()).toBe(before);
  }, 60_000);

  it('resumes a session with its key: the same id, and a token that reaches its earlier run', async () => {
    const first = await opened();
    const started = await startRun(first.token, first.sessionId);
    expect(started.status, await started.clone().text()).toBe(202);
    const runId = ((await started.json()) as { run: { id: string } }).run.id;

    const resumed = await opened({ resume: resumeOf(first) });
    expect(resumed.sessionId).toBe(first.sessionId);
    expect(resumed.agentId).toBe(agentId);
    expect(resumed.resumeKey).toBeUndefined();
    expect(resumed.token).not.toBe(first.token);

    const bearer = { authorization: `Bearer ${resumed.token}` };
    const read = await readRunRoute(
      new NextRequest(`${ORIGIN}/api/runs/${runId}`, { headers: bearer }),
      { params: Promise.resolve({ id: runId }) },
    );
    expect(read.status, await read.clone().text()).toBe(200);
    const abort = new AbortController();
    const events = await runEventsRoute(
      new NextRequest(`${ORIGIN}/api/runs/${runId}/events`, {
        headers: bearer,
        signal: abort.signal,
      }),
      { params: Promise.resolve({ id: runId }) },
    );
    expect(events.status).toBe(200);
    abort.abort();
    await events.body?.cancel();

    const again = await startRun(resumed.token, first.sessionId);
    expect(again.status, await again.clone().text()).toBe(202);
  }, 60_000);

  it('stores only the SHA-256 of the resume key', async () => {
    const session = await opened();
    const [row] = await db()
      .db.select()
      .from(surfaceSessionKeys)
      .where(eq(surfaceSessionKeys.sessionId, session.sessionId));
    const { resumeKey } = resumeOf(session);
    expect(row?.keyHash).not.toBe(resumeKey);
    expect(row?.keyHash).toBe(createHash('sha256').update(resumeKey).digest('hex'));
    expect(row).toMatchObject({ surfaceName: 'main', agentId });
  }, 60_000);

  it('answers a wrong key exactly as an unknown session: 404 surface_session_not_resumable', async () => {
    const session = await opened();
    const wrong = await bootstrap('main', {
      resume: { sessionId: session.sessionId, resumeKey: 'x'.repeat(43) },
    });
    const unknown = await bootstrap('main', {
      resume: { sessionId: crypto.randomUUID(), resumeKey: resumeOf(session).resumeKey },
    });
    expect(wrong.status).toBe(404);
    expect(unknown.status).toBe(404);
    const wrongBody: unknown = await wrong.json();
    expect(wrongBody).toEqual(await unknown.json());
    expect(ApiProblemSchema.parse(wrongBody).error.code).toBe('surface_session_not_resumable');
  }, 60_000);

  it('refuses an agent the surface does not offer, and an offered one of another owner', async () => {
    const before = await sessionCount();
    for (const agent of ['other', STRANGER]) {
      const response = await bootstrap('main', { agent });
      expect(response.status).toBe(404);
      await expect(codeOf(response)).resolves.toBe('surface_agent_not_offered');
    }
    expect(await sessionCount()).toBe(before);
  }, 60_000);

  it('opens a switcher session as the offered agent and its owner, and runs in it', async () => {
    const session = await opened({ agent: BILLING });
    expect(session.agentId).toBe(billingId);
    const [row] = await db().db.select().from(sessions).where(eq(sessions.id, session.sessionId));
    expect(row?.agentId).toBe(billingId);
    expect(row?.ownerPrincipalId).toBe(ownerPrincipalId);
    const started = await startRun(session.token, session.sessionId, billingId);
    expect(started.status, await started.clone().text()).toBe(202);
  }, 60_000);

  it('switches A → B → A: A key resumes A, and B key never resumes A', async () => {
    const desk = await opened();
    const billing = await opened({ agent: BILLING });
    const back = await opened({ resume: resumeOf(desk) });
    expect(back.sessionId).toBe(desk.sessionId);
    expect(back.agentId).toBe(agentId);

    const crossed = await bootstrap('main', {
      resume: { sessionId: desk.sessionId, resumeKey: resumeOf(billing).resumeKey },
    });
    expect(crossed.status).toBe(404);
    await expect(codeOf(crossed)).resolves.toBe('surface_session_not_resumable');
    const billingBack = await opened({ agent: BILLING, resume: resumeOf(billing) });
    expect(billingBack.sessionId).toBe(billing.sessionId);
  }, 60_000);

  it('does not resume an archived session', async () => {
    const session = await opened();
    await db()
      .db.update(sessions)
      .set({ status: 'archived' })
      .where(eq(sessions.id, session.sessionId));
    const response = await bootstrap('main', { resume: resumeOf(session) });
    expect(response.status).toBe(404);
    await expect(codeOf(response)).resolves.toBe('surface_session_not_resumable');
  }, 60_000);

  it('opens a session for an allowed origin off loopback, and caps its turns (#622)', async () => {
    const response = await createSurfaceSessionRoute(
      new Request('https://aw.example.com/p/s/shop/sessions', {
        method: 'POST',
        headers: { host: 'aw.example.com', origin: SHOP_ORIGIN, 'sec-fetch-site': 'cross-site' },
      }),
      { params: Promise.resolve({ name: 'shop' }) },
    );
    expect(response.status, await response.clone().text()).toBe(201);
    expect(response.headers.get('access-control-allow-origin')).toBe(SHOP_ORIGIN);
    const session = SurfaceSessionResponseSchema.parse(await response.json());

    const first = await startRun(session.token, session.sessionId, shopId);
    expect(first.status, await first.clone().text()).toBe(202);
    const before = await sessionCount();
    const second = await startRun(session.token, session.sessionId, shopId);
    expect(second.status).toBe(429);
    await expect(codeOf(second)).resolves.toBe('surface_turn_limit_reached');
    expect(await sessionCount()).toBe(before);

    const refused = await createSurfaceSessionRoute(
      new Request('https://aw.example.com/p/s/shop/sessions', {
        method: 'POST',
        headers: { host: 'aw.example.com', origin: 'https://evil.example' },
      }),
      { params: Promise.resolve({ name: 'shop' }) },
    );
    expect(refused.status).toBe(403);
    await expect(codeOf(refused)).resolves.toBe('surface_origin_not_allowed');
  }, 60_000);

  it('serves the public the production version and the try page local, pinning each (#612)', async () => {
    const headers = { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' };
    const params = { params: Promise.resolve({ id: billingId }) };
    const point = async (environment: string, version: number): Promise<void> => {
      const moved = await setPointerRoute(
        new Request(`${ORIGIN}/api/agents/${billingId}/pointers`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ environment, version }),
        }),
        params,
      );
      expect(moved.status, await moved.text()).toBe(200);
    };
    const pinOf = async (response: Response): Promise<string | null | undefined> => {
      expect(response.status, await response.clone().text()).toBe(201);
      const { sessionId } = SurfaceSessionResponseSchema.parse(await response.json());
      const [row] = await db()
        .db.select({ pin: sessions.agentVersionId })
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      return row?.pin;
    };
    const before = await pinOf(await bootstrap('billing'));

    // Promote v1, then `aw push` v2: a new version, and `local` moved onto it.
    await point('production', 1);
    const { version } = agentWithSurface(BILLING, 'billing', PROFILE_NAME) as {
      version: Record<string, unknown>;
    };
    const saved = await createVersionRoute(
      new Request(`${ORIGIN}/api/agents/${billingId}/versions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...version, summary: 'Second version' }),
      }),
      params,
    );
    expect(saved.status, await saved.text()).toBe(201);
    await point('local', 2);

    const publicPin = await pinOf(await bootstrap('billing'));
    const tryPin = await pinOf(await bootstrap('billing', { environment: 'local' }));
    expect(publicPin).toBe(before);
    expect(tryPin).not.toBe(before);
    expect(tryPin).toEqual(expect.any(String));
  }, 60_000);

  it('keeps a visitor on the version it opened on, with its turn cap, after a promote (#622)', async () => {
    const headers = { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' };
    const embedded = (turnsPerConversation: number) =>
      agentWithSurface('Pinned shop', 'pinned', PROFILE_NAME, [], {
        allowedOrigins: [SHOP_ORIGIN],
        limits: { turnsPerConversation },
      }) as { version: Record<string, unknown> };
    const created = await createAgentRoute(
      new Request(`${ORIGIN}/api/agents`, {
        method: 'POST',
        headers,
        body: JSON.stringify(embedded(1)),
      }),
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const pinnedId = ((await created.json()) as { agent: { id: string } }).agent.id;
    const params = { params: Promise.resolve({ id: pinnedId }) };
    const point = async (environment: string, version: number): Promise<void> => {
      const moved = await setPointerRoute(
        new Request(`${ORIGIN}/api/agents/${pinnedId}/pointers`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ environment, version }),
        }),
        params,
      );
      expect(moved.status, await moved.text()).toBe(200);
    };
    const visitor = async (): Promise<SurfaceSessionResponse> => {
      const response = await createSurfaceSessionRoute(
        new Request('https://aw.example.com/p/s/pinned/sessions', {
          method: 'POST',
          headers: { host: 'aw.example.com', origin: SHOP_ORIGIN, 'sec-fetch-site': 'cross-site' },
        }),
        { params: Promise.resolve({ name: 'pinned' }) },
      );
      expect(response.status, await response.clone().text()).toBe(201);
      return SurfaceSessionResponseSchema.parse(await response.json());
    };
    const pinOf = async (sessionId: string): Promise<string | null | undefined> =>
      (
        await db()
          .db.select({ pin: sessions.agentVersionId })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
      )[0]?.pin;

    // v1 (one turn per conversation) is in production when the visitor opens a conversation.
    await point('production', 1);
    const onV1 = await visitor();
    const v1 = await pinOf(onV1.sessionId);
    expect(v1).toEqual(expect.any(String));

    // v2 (three turns) is saved and promoted while that conversation is open.
    const saved = await createVersionRoute(
      new Request(`${ORIGIN}/api/agents/${pinnedId}/versions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...embedded(3).version, summary: 'Second version' }),
      }),
      params,
    );
    expect(saved.status, await saved.text()).toBe(201);
    await point('local', 2);
    await point('production', 2);

    const first = await startRun(onV1.token, onV1.sessionId, pinnedId);
    expect(first.status, await first.clone().text()).toBe(202);
    const second = await startRun(onV1.token, onV1.sessionId, pinnedId);
    expect(second.status).toBe(429);
    await expect(codeOf(second)).resolves.toBe('surface_turn_limit_reached');
    expect(await pinOf(onV1.sessionId)).toBe(v1);

    // A conversation opened after the promote runs v2, under v2's cap.
    const onV2 = await visitor();
    expect(await pinOf(onV2.sessionId)).not.toBe(v1);
    for (let turn = 0; turn < 2; turn += 1) {
      const started = await startRun(onV2.token, onV2.sessionId, pinnedId);
      expect(started.status, await started.clone().text()).toBe(202);
    }
  }, 60_000);
});
