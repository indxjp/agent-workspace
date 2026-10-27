/**
 * Issue #388: the SDK quickstart, run with a workspace API key and nothing else — list agents,
 * start a run, follow it, read the settled record — through the edge gate (`proxy()`), the real
 * route files, and the production composition (`register()`) against PostgreSQL.
 *
 * `proxy.test.ts` pins which routes the edge admits a key on; a route's own tests call its handler
 * directly and never cross the edge. Neither alone catches the defect #388 reported — every route
 * green in its own suite and a `401 no_session_cookie` in every deployment — so this suite puts
 * the published client (`@indx-workspace/sdk`) in front of both. Its `fetch` sends each request
 * through `proxy()` first and reaches the route file only when the edge passed it on
 * (`x-middleware-next: 1`), which is what Next does with a proxy's `NextResponse.next()`.
 *
 * Identification is `installRbacApi`'s `resolveActor` (`session-rbac.ts`) over the `api_keys`
 * table: the key is hashed and looked up, and a revoked, expired or unknown one is no identity at
 * all. Agents are created through the route by the keys themselves, so ownership is the persisted
 * machine principal's, and every authorisation decision is the shipped `decide()`. The one part
 * substituted is the runtime: the run API the composition installed is kept whole — its store is
 * the PostgreSQL one — and only `launch` is replaced by one that settles the run in-process.
 *
 * `runs.start` refuses an agent with no runtime profile or no resolvable model before it queues
 * anything (issue #393), so the agents carry a runtime profile and a ready Anthropic connection.
 * The connection's `baseUrl` is a loopback stand-in for the provider's model list — the real
 * discovery path (registry adapter, egress guard, cache) runs against it, with no network.
 */
import crypto from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ApiProblemError, createClient, type RunEventFrame } from '@indx-workspace/sdk';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  apiKeys,
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  runs,
  runtimeProfiles,
  sessions,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { eq } from 'drizzle-orm';
import { POST as startRunRoute } from '../../app/api/agents/[id]/runs/route';
import { GET as listAgentsRoute, POST as createAgentRoute } from '../../app/api/agents/route';
import { GET as runEventsRoute } from '../../app/api/runs/[id]/events/route';
import { GET as readRunRoute } from '../../app/api/runs/[id]/route';
import { proxy } from '../../proxy';
import { applicationContext } from '../application-context';
import { mintApiKey } from '../rbac/api-key';
import { getRunApi } from '../runs/environment';

import type { RegisteredComposition } from './register';
import { installTestRunApi } from '../application-context-fixtures';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

if (!hasDatabase) {
  console.warn(
    '[composition/api-key-quickstart.integration.test.ts] SKIPPED — TEST_DATABASE_URL is not set, ' +
      'so the quickstart was not run with an API key through the edge and the composition.',
  );
}

const CONTROLLED_ENV = [
  'AW_STORAGE_URL',
  'AW_RUNTIME_VERIFICATION_FILE',
  'DATABASE_URL',
  'GATEWAY_TOKEN_SECRET',
  'MASTER_ENCRYPTION_KEY',
  'NEXT_RUNTIME',
  'RUNNER_MANAGER_TOKEN',
  'RUNNER_MANAGER_URL',
  'RUNNER_URL',
  'SESSION_SECRET',
] as const;

const BASE_URL = 'http://127.0.0.1:3000';
const PASSED_THROUGH = 'x-middleware-next';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The instant the expiry test pins the application clock to. The lookup compares `expires_at`
 * with `greatest(now(), $now)` — the database's clock and the one the route passes — so the pinned
 * instant sits an hour ahead of real time: it is always the greater of the two, and the boundary
 * below is decided by it alone, never by how long the suite took to get there.
 */
const PINNED_NOW = new Date(Date.now() + HOUR_MS);

type RouteHandler = (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) => Promise<Response>;

/** The route files the quickstart reaches, by method and path shape. */
const ROUTES: readonly {
  readonly method: string;
  readonly pattern: RegExp;
  readonly handler: RouteHandler;
}[] = [
  { method: 'GET', pattern: /^\/api\/agents$/u, handler: listAgentsRoute },
  { method: 'POST', pattern: /^\/api\/agents$/u, handler: createAgentRoute },
  { method: 'POST', pattern: /^\/api\/agents\/([^/]+)\/runs$/u, handler: startRunRoute },
  { method: 'GET', pattern: /^\/api\/runs\/([^/]+)$/u, handler: readRunRoute },
  { method: 'GET', pattern: /^\/api\/runs\/([^/]+)\/events$/u, handler: runEventsRoute },
];

/** `METHOD path` of every request the edge passed on to a route file, in order. */
const reachedRoutes: string[] = [];

/** Edge first, then the route file — or the edge's own refusal, exactly as Next serves it. */
async function serve(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new NextRequest(input instanceof Request ? input : new Request(input, init));
  const gated = await proxy(request);
  if (gated.headers.get(PASSED_THROUGH) !== '1') return gated;
  const { pathname } = request.nextUrl;
  for (const route of ROUTES) {
    const match = route.method === request.method ? route.pattern.exec(pathname) : null;
    if (match === null) continue;
    reachedRoutes.push(`${request.method} ${pathname}`);
    return route.handler(request, { params: Promise.resolve({ id: match[1] ?? '' }) });
  }
  throw new Error(`the quickstart harness has no route for ${request.method} ${pathname}`);
}

function client(apiKey: string): ReturnType<typeof createClient> {
  return createClient({
    baseUrl: BASE_URL,
    auth: { kind: 'api-key', apiKey },
    fetch: serve,
    timeoutMs: 10_000,
  });
}

/**
 * Awaits one call's refusal. It takes the call itself, not its promise, so a caller refusing several
 * calls in turn starts each only once the previous one settled: a promise created ahead of its
 * `await` rejects with no handler attached, and vitest reports it as an unhandled error.
 */
async function refusal(call: () => Promise<unknown>): Promise<ApiProblemError> {
  const outcome = await call().then(
    () => null,
    (error: unknown) => error,
  );
  if (!(outcome instanceof ApiProblemError)) {
    throw new Error(`expected an ApiProblemError, got ${String(outcome)}`);
  }
  return outcome;
}

const AGENT_MODEL = 'claude-sonnet-4-5';

/**
 * A loopback stand-in for Anthropic's `GET /v1/models`, so the preflight's model discovery
 * succeeds offline and finds the agents' model.
 */
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

const AGENT_BODY = {
  instructions: 'Answer briefly.',
  model: AGENT_MODEL,
  permissions: {
    readFiles: true,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: false,
  },
} as const;

describe.skipIf(!hasDatabase)('the SDK quickstart with an API key (issue #388)', () => {
  let isolated: IsolatedTestDatabase | undefined;
  let composition: RegisteredComposition | undefined;
  let modelListServer: Server | undefined;
  const previousEnv = new Map<string, string | undefined>();
  const keys = new Map<string, { readonly presented: string; readonly id: string }>();
  let builderAgentId = '';
  let ownerAgentId = '';
  let fixtureWorkspaceId = '';
  let fixtureConnectionId = '';

  function key(name: string): string {
    const found = keys.get(name);
    if (found === undefined) throw new Error(`no fixture key ${name}`);
    return found.presented;
  }

  beforeAll(async () => {
    for (const name of CONTROLLED_ENV) previousEnv.set(name, process.env[name]);
    isolated = await createIsolatedTestDatabase('aw_api_key_quickstart');
    const workspaceId = crypto.randomUUID();
    fixtureWorkspaceId = workspaceId;
    await isolated.db.insert(workspaces).values({
      id: workspaceId,
      slug: 'api-key-quickstart',
      name: 'API-key quickstart',
    });
    const fixtures = [
      { name: 'builder', role: 'builder' },
      { name: 'viewer', role: 'viewer' },
      { name: 'owner', role: 'owner' },
      { name: 'revoked', role: 'owner' },
      { name: 'expiring', role: 'owner' },
      { name: 'expired', role: 'owner' },
    ] as const;
    for (const fixture of fixtures) {
      const minted = await mintApiKey();
      const id = crypto.randomUUID();
      await isolated.db.insert(apiKeys).values({
        id,
        workspaceId,
        name: `quickstart-${fixture.name}`,
        role: fixture.role,
        keyPrefix: minted.keyPrefix,
        keyHash: minted.keyHash,
        // Minted two days before the pinned instant, so every lifecycle below respects
        // `expires_at > created_at` and `revoked_at >= created_at`: one key that expires one
        // millisecond after the pinned instant, one that expires exactly at it — the two sides of
        // the boundary — and one revoked the day before.
        ...(fixture.name === 'owner' || fixture.name === 'builder' || fixture.name === 'viewer'
          ? {}
          : { createdAt: new Date(PINNED_NOW.getTime() - 2 * DAY_MS) }),
        ...(fixture.name === 'expiring' ? { expiresAt: new Date(PINNED_NOW.getTime() + 1) } : {}),
        ...(fixture.name === 'expired' ? { expiresAt: PINNED_NOW } : {}),
        ...(fixture.name === 'revoked'
          ? { revokedAt: new Date(PINNED_NOW.getTime() - DAY_MS) }
          : {}),
      });
      keys.set(fixture.name, { presented: minted.presented, id });
    }

    process.env['DATABASE_URL'] = isolated.url;
    process.env['SESSION_SECRET'] = 'api-key-quickstart-test-secret-at-least-32-characters';
    process.env['MASTER_ENCRYPTION_KEY'] = crypto.randomBytes(32).toString('hex');
    process.env['RUNNER_URL'] = 'http://127.0.0.1:9';
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
    const { register } = await import('./register');
    composition = await register();
    if (composition === undefined) throw new Error('composition registration was skipped');

    // What `runs.start` needs before it queues a run (issue #393): a runtime profile on the agent
    // and a ready model connection whose model list offers the agent's model.
    const modelList = await startModelListServer();
    modelListServer = modelList.server;
    const models = applicationContext()?.models;
    if (models?.kind !== 'serving') throw new Error('the composition installed no models API');
    const modelsRuntime = models.runtime;
    const connection = await modelsRuntime.models.forWorkspace(workspaceId).create({
      name: 'quickstart-anthropic',
      provider: 'anthropic',
      apiKey: 'sk-ant-quickstart-fixture',
      config: { baseUrl: modelList.url },
    });
    if (connection.kind !== 'created') throw new Error(`model connection: ${connection.kind}`);
    const [profile] = await isolated.db
      .insert(runtimeProfiles)
      .values({
        workspaceId,
        name: 'quickstart-local',
        driver: 'local',
        networkPolicy: 'none',
        filesystem: 'read-only',
      })
      .returning({ id: runtimeProfiles.id });
    if (profile === undefined) throw new Error('the runtime profile was not created');
    fixtureConnectionId = connection.connection.id;
    const runnable = {
      modelConnectionId: connection.connection.id,
      runtimeProfileId: profile.id,
    };

    // The run API the composition installed, whole — its authentication, agent lookup, sessions
    // and PostgreSQL store — with only the runtime's part settled in-process: running, one relayed
    // event, completed.
    const installed = getRunApi();
    if (installed === null) throw new Error('the composition installed no run API');
    const { store } = installed;
    installTestRunApi({
      ...installed,
      launch: ({ run }) => {
        void (async () => {
          await store.markRunning(run.id);
          await store.append(run.id, { type: 'assistant', data: { text: 'Three things.' } });
          await store.finish(run.id, 'completed', null, true);
        })();
      },
    });

    // As `aw agents create` would, with each key: a Builder runs the agents it owns (§21), an
    // Owner or Admin runs any.
    const created: string[] = [];
    for (const [owner, name] of [
      ['builder', 'Researcher'],
      ['owner', 'Reviewer'],
    ] as const) {
      const response = await serve(`${BASE_URL}/api/agents`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key(owner)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...AGENT_BODY, ...runnable, name }),
      });
      const text = await response.text();
      if (response.status !== 201) throw new Error(`creating ${name}: ${text}`);
      created.push((JSON.parse(text) as { id: string }).id);
    }
    [builderAgentId = '', ownerAgentId = ''] = created;
  }, 180_000);

  afterEach(() => {
    vi.useRealTimers();
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
    if (isolated !== undefined) {
      await closeIsolatedTestResources(
        isolated,
        ...(composition === undefined ? [] : [composition]),
      );
    }
  });

  it('lists agents, starts a run, follows it to its end and reads the settled record', async () => {
    const aw = client(key('builder'));

    const agents = await aw.agents.list();
    expect(agents.map((agent) => agent.name).sort()).toEqual(['Researcher', 'Reviewer']);

    const { run } = await aw.runs.start(builderAgentId, {
      prompt: 'Summarise the three most important things about this workspace.',
    });
    expect(run.status).toBe('queued');

    const frames: RunEventFrame[] = [];
    for await (const frame of aw.runs.follow(run.id, { maxReconnects: 0 })) frames.push(frame);
    expect(frames.some((frame) => frame.kind === 'runtime' && frame.name === 'assistant')).toBe(
      true,
    );
    expect(
      frames.some((frame) => frame.kind === 'run-status' && frame.data.status === 'completed'),
    ).toBe(true);

    const settled = await aw.runs.get(run.id);
    expect(settled.id).toBe(run.id);
    expect(settled.status).toBe('completed');
  }, 60_000);

  it('lets an Owner key run an agent it did not create', async () => {
    const { run } = await client(key('owner')).runs.start(builderAgentId, { prompt: 'Hello.' });
    expect(run.status).toBe('queued');
  });

  it('refuses a Builder key an agent another principal owns, as §21 reads "run what it owns"', async () => {
    const problem = await refusal(() =>
      client(key('builder')).runs.start(ownerAgentId, { prompt: 'Hello.' }),
    );
    expect(problem.status).toBe(403);
    expect(problem.code).toBe('forbidden');
  });

  it('lets a Viewer key list agents and refuses it a run', async () => {
    const aw = client(key('viewer'));
    expect((await aw.agents.list()).length).toBe(2);

    const problem = await refusal(() => aw.runs.start(builderAgentId, { prompt: 'Hello.' }));
    expect(problem.status).toBe(403);
    expect(problem.code).toBe('forbidden');
  });

  it('refuses a revoked key at the route, after the edge admitted its shape', async () => {
    reachedRoutes.length = 0;
    const aw = client(key('revoked'));
    for (const call of [
      () => aw.agents.list(),
      () => aw.runs.start(builderAgentId, { prompt: 'Hello.' }),
    ]) {
      const problem = await refusal(call);
      expect(problem.status).toBe(401);
      expect(problem.code).toBe('unauthenticated');
    }
    // The refusal is the route's own verification, not the edge's shape check.
    expect(reachedRoutes).toEqual(['GET /api/agents', `POST /api/agents/${builderAgentId}/runs`]);
  });

  it('accepts a key before its expiry and refuses one at it, the same way', async () => {
    // Only `Date` is pinned: timers, the database driver and the SDK's deadline keep real time.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(PINNED_NOW);

    expect((await client(key('expiring')).agents.list()).length).toBe(2);

    const aw = client(key('expired'));
    for (const call of [
      () => aw.agents.list(),
      () => aw.runs.start(builderAgentId, { prompt: 'Hello.' }),
    ]) {
      const problem = await refusal(call);
      expect(problem.status).toBe(401);
      expect(problem.code).toBe('unauthenticated');
    }
  });

  it('refuses an unknown key that has the right shape', async () => {
    const problem = await refusal(() =>
      client(`ak_live_${'A'.repeat(22)}_${'B'.repeat(43)}`).agents.list(),
    );
    expect(problem.status).toBe(401);
    expect(problem.code).toBe('unauthenticated');
  });

  // PR #403 review: a refused first message is decided before its session is opened, so it
  // leaves neither a run nor an empty session behind. Last in the file: it adds a third agent.
  it('refuses a profile-less agent with 422 and creates no run and no session', async () => {
    const created = await serve(`${BASE_URL}/api/agents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key('owner')}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...AGENT_BODY,
        modelConnectionId: fixtureConnectionId,
        name: 'Unprofiled',
      }),
    });
    expect(created.status).toBe(201);
    const { id: unprofiledId } = (await created.json()) as { id: string };
    const count = async (): Promise<{ sessions: number; runs: number }> => ({
      sessions: (
        await isolated!.db
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.workspaceId, fixtureWorkspaceId))
      ).length,
      runs: (
        await isolated!.db
          .select({ id: runs.id })
          .from(runs)
          .where(eq(runs.workspaceId, fixtureWorkspaceId))
      ).length,
    });
    const before = await count();

    const problem = await refusal(() =>
      client(key('owner')).runs.start(unprofiledId, { prompt: 'Hello.' }),
    );
    expect(problem.status).toBe(422);
    expect(problem.code).toBe('agent_runtime_profile_missing');
    expect(await count()).toEqual(before);

    // A session the client opened itself (as `projects.startSession` does) stays the client's: a
    // refused first start neither runs in it nor deletes it, so a retry with the same id is
    // refused for the same reason, never answered 409 session_not_usable.
    const [ownerPrincipal] = await isolated!.db
      .select({ id: workspacePrincipals.id })
      .from(workspacePrincipals)
      .where(eq(workspacePrincipals.apiKeyId, keys.get('owner')?.id ?? ''));
    if (ownerPrincipal === undefined) throw new Error('the owner key has no principal');
    const openedFirst = crypto.randomUUID();
    await isolated!.db.insert(sessions).values({
      id: openedFirst,
      workspaceId: fixtureWorkspaceId,
      agentId: unprofiledId,
      ownerPrincipalId: ownerPrincipal.id,
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const refused = await refusal(() =>
        client(key('owner')).runs.start(unprofiledId, { prompt: 'Hello.', sessionId: openedFirst }),
      );
      expect(refused.code).toBe('agent_runtime_profile_missing');
    }
    expect(await count()).toEqual({ sessions: before.sessions + 1, runs: before.runs });
  });
});
