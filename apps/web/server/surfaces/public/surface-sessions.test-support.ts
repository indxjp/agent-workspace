/** PostgreSQL-backed surface sessions with real composition and a loopback model provider. */
import crypto from 'node:crypto';

import { createServer, type Server } from 'node:http';

import { eq } from 'drizzle-orm';

import { NextRequest } from 'next/server';

import { afterAll, beforeAll, expect } from 'vitest';

import {
  apiKeys,
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  runtimeProfiles,
  sessions,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';

import { ApiProblemSchema } from '@indx-workspace/contracts';

import {
  SurfaceSessionResponseSchema,
  type SurfaceSessionResponse,
} from '@indx-workspace/contracts/surfaces';

import { POST as startRunRoute } from '../../../app/api/agents/[id]/runs/route';

import { POST as createAgentRoute } from '../../../app/api/agents/route';

import { POST as createSurfaceSessionRoute } from '../../../app/p/s/[name]/sessions/route';

import { fixtureSurface, fromVersionRequest } from '../../agent-versions/fixtures';

import { applicationContext } from '../../application-context';

import { installTestRunApi } from '../../application-context-fixtures';

import type { RegisteredComposition } from '../../composition/register';

import { mintApiKey } from '../../rbac/api-key';

import { getRunApi } from '../../runs/environment';
const CONTROLLED_ENV = [
  'AW_STORAGE_URL',
  'AW_LOCAL_SURFACE_SESSIONS',
  'AW_RUNTIME_VERIFICATION_FILE',
  'BOOTSTRAP_ADMIN',
  'BOOTSTRAP_ADMIN_PASSWORD',
  'DATABASE_URL',
  'GATEWAY_TOKEN_SECRET',
  'HOST',
  'HOSTNAME',
  'MASTER_ENCRYPTION_KEY',
  'NEXT_RUNTIME',
  'RUNNER_MANAGER_TOKEN',
  'RUNNER_MANAGER_URL',
  'RUNNER_URL',
  'SESSION_SECRET',
  'WORKSPACE_SLUG',
] as const;

const WORKSPACE_SLUG = 'surface-sessions';

export const ORIGIN = 'http://127.0.0.1:4310';

const AGENT_MODEL = 'claude-sonnet-4-5';

const CONNECTION_NAME = 'surface-anthropic';

export const PROFILE_NAME = 'surface-local';

export const BILLING = 'Billing desk';

export const STRANGER = 'Stranger desk';

export const SHOP_ORIGIN = 'https://shop.example.com';

async function startModelListServer(): Promise<{
  readonly server: Server;
  readonly url: string;
}> {
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
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('model server has no TCP address');
  const { port } = address;
  return { server, url: `http://127.0.0.1:${String(port)}` };
}

interface SurfaceAgentOptions {
  readonly name: string;
  readonly surface: string;
  readonly runtimeProfileName: string | null;
  readonly switcher?: readonly string[];
  readonly embedding?: Readonly<Record<string, unknown>>;
}

export function agentWithSurface({
  name,
  surface,
  runtimeProfileName,
  switcher = [],
  embedding = {},
}: SurfaceAgentOptions): unknown {
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

export function createSurfaceSessionFixture(env: NodeJS.ProcessEnv) {
  return new SurfaceSessionFixture(env);
}

class SurfaceSessionFixture {
  constructor(private readonly env: NodeJS.ProcessEnv) {
    beforeAll(() => this.setup(), 180_000);
    afterAll(() => this.teardown());
  }

  private isolated: IsolatedTestDatabase | undefined;

  private composition: RegisteredComposition | undefined;

  private modelListServer: Server | undefined;

  private previousEnv = new Map<string, string | undefined>();

  workspaceId = crypto.randomUUID();

  owner = { key: '', principalId: '' };

  readonly agentIds = { main: '', billing: '', shop: '' };

  /** The finish of the last launched run; `startRun` waits for it. */
  private ended: Promise<void> = Promise.resolve();

  db(): IsolatedTestDatabase {
    if (this.isolated === undefined) throw new Error('the isolated database was not created');
    return this.isolated;
  }

  async sessionCount(): Promise<number> {
    return (
      await this.db()
        .db.select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.workspaceId, this.workspaceId))
    ).length;
  }

  /** An owner API key in the workspace: its presented secret and its principal. */
  async ownerApiKey(name: string): Promise<{ key: string; principalId: string }> {
    const minted = await mintApiKey();
    const apiKeyId = crypto.randomUUID();
    await this.db().db.insert(apiKeys).values({
      id: apiKeyId,
      workspaceId: this.workspaceId,
      name,
      role: 'owner',
      keyPrefix: minted.keyPrefix,
      keyHash: minted.keyHash,
    });
    const principal = (await this.db().db.select().from(workspacePrincipals)).find(
      (candidate) => candidate.apiKeyId === apiKeyId,
    );
    if (principal === undefined) throw new Error('the API-key principal trigger created nothing');
    return { key: minted.presented, principalId: principal.id };
  }

  private async setup() {
    for (const name of CONTROLLED_ENV) this.previousEnv.set(name, this.env[name]);
    this.isolated = await createIsolatedTestDatabase('aw_surface_sessions');
    await this.isolated.db
      .insert(workspaces)
      .values({ id: this.workspaceId, slug: WORKSPACE_SLUG, name: 'Surface sessions' });
    this.owner = await this.ownerApiKey('surface-owner');
    const stranger = await this.ownerApiKey('surface-stranger');

    this.configureEnvironment();
    const { register } = await import('../../composition/register');
    this.composition = await register();
    if (this.composition === undefined) throw new Error('composition registration was skipped');
    await this.configureRuntime();
    this.finishLaunchedRuns();
    await this.seedAgents(stranger.key);
  }

  private configureEnvironment() {
    this.env['DATABASE_URL'] = this.db().url;
    this.env['SESSION_SECRET'] = 'surface-sessions-test-secret-at-least-32-characters';
    this.env['MASTER_ENCRYPTION_KEY'] = crypto.randomBytes(32).toString('hex');
    this.env['RUNNER_URL'] = 'http://127.0.0.1:9';
    this.env['BOOTSTRAP_ADMIN'] = 'owner@surface-sessions.test';
    this.env['BOOTSTRAP_ADMIN_PASSWORD'] = 'surface-sessions-password';
    this.env['WORKSPACE_SLUG'] = WORKSPACE_SLUG;
    this.env['AW_LOCAL_SURFACE_SESSIONS'] = '1';
    this.env['HOST'] = '127.0.0.1';
    for (const name of [
      'AW_STORAGE_URL',
      'AW_RUNTIME_VERIFICATION_FILE',
      'GATEWAY_TOKEN_SECRET',
      'HOSTNAME',
      'NEXT_RUNTIME',
      'RUNNER_MANAGER_TOKEN',
      'RUNNER_MANAGER_URL',
    ] as const) {
      delete this.env[name];
    }
  }

  private async configureRuntime() {
    const modelList = await startModelListServer();
    this.modelListServer = modelList.server;
    const models = applicationContext()?.models;
    if (models?.kind !== 'serving') throw new Error('the composition installed no models API');
    const modelsRuntime = models.runtime;
    const connection = await modelsRuntime.models.forWorkspace(this.workspaceId).create({
      name: CONNECTION_NAME,
      provider: 'anthropic',
      apiKey: 'sk-ant-surface-fixture',
      config: { baseUrl: modelList.url },
    });
    if (connection.kind !== 'created') throw new Error(`model connection: ${connection.kind}`);
    await this.db().db.insert(runtimeProfiles).values({
      workspaceId: this.workspaceId,
      name: PROFILE_NAME,
      driver: 'local',
      networkPolicy: 'none',
      filesystem: 'read-only',
    });
  }

  private finishLaunchedRuns() {
    // The installed run API, whole, with a launch that runs nothing and ends the run at once: a
    // session takes one run at a time, so a visitor's next turn needs the last one finished.
    const installed = getRunApi();
    if (installed === null) throw new Error('the composition installed no run API');
    installTestRunApi({
      ...installed,
      launch: (context) => {
        this.ended = installed.store.finish(context.run.id, 'completed', null);
      },
    });
  }

  private async seedAgents(strangerKey: string) {
    const agents = [
      {
        name: 'Front desk',
        surface: 'main',
        runtimeProfileName: PROFILE_NAME,
        key: this.owner.key,
        switcher: [BILLING, STRANGER],
      },
      { name: BILLING, surface: 'billing', runtimeProfileName: PROFILE_NAME, key: this.owner.key },
      { name: STRANGER, surface: 'stranger', runtimeProfileName: PROFILE_NAME, key: strangerKey },
      { name: 'Unprofiled desk', surface: 'bare', runtimeProfileName: null, key: this.owner.key },
    ];
    for (const { key, ...options } of agents) {
      const created = await this.createAgent(options, key);
      if (options.surface === 'main') this.agentIds.main = created;
      if (options.surface === 'billing') this.agentIds.billing = created;
    }
    this.agentIds.shop = await this.createAgent(
      {
        name: 'Shop desk',
        surface: 'shop',
        runtimeProfileName: PROFILE_NAME,
        embedding: { allowedOrigins: [SHOP_ORIGIN], limits: { turnsPerConversation: 1 } },
      },
      this.owner.key,
    );
  }

  private async createAgent(options: SurfaceAgentOptions, key: string): Promise<string> {
    const response = await createAgentRoute(
      new Request(`${ORIGIN}/api/agents`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(agentWithSurface(options)),
      }),
    );
    const text = await response.text();
    if (response.status !== 201) throw new Error(`creating ${options.name}: ${text}`);
    return (JSON.parse(text) as { agent: { id: string } }).agent.id;
  }

  private async teardown() {
    for (const [name, value] of this.previousEnv) {
      if (value === undefined) delete this.env[name];
      else this.env[name] = value;
    }
    if (this.modelListServer !== undefined) {
      const server = this.modelListServer;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (this.isolated !== undefined) {
      await closeIsolatedTestResources(
        this.isolated,
        ...(this.composition === undefined ? [] : [this.composition]),
      );
    }
  }

  bootstrap(name: string, options?: unknown): Promise<Response> {
    return createSurfaceSessionRoute(
      new Request(`${ORIGIN}/p/s/${name}/sessions`, {
        method: 'POST',
        headers: { host: '127.0.0.1:4310', origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
        ...(options === undefined ? {} : { body: JSON.stringify(options) }),
      }),
      { params: Promise.resolve({ name }) },
    );
  }

  async opened(options?: unknown): Promise<SurfaceSessionResponse> {
    const response = await this.bootstrap('main', options);
    expect(response.status, await response.clone().text()).toBe(201);
    return SurfaceSessionResponseSchema.parse(await response.json());
  }

  resumeOf(session: SurfaceSessionResponse): { sessionId: string; resumeKey: string } {
    if (session.resumeKey === undefined) throw new Error('a new session carries a resume key');
    return { sessionId: session.sessionId, resumeKey: session.resumeKey };
  }

  async startRun(token: string, sessionId: string, agent = this.agentIds.main): Promise<Response> {
    const response = await startRunRoute(
      new NextRequest(`${ORIGIN}/api/agents/${agent}/runs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Where is my order?', sessionId }),
      }),
      { params: Promise.resolve({ id: agent }) },
    );
    await this.ended;
    return response;
  }

  async codeOf(response: Response): Promise<string> {
    return ApiProblemSchema.parse(await response.json()).error.code;
  }
}
