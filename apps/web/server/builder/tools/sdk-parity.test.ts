import crypto from 'node:crypto';

import {
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
} from '@agent-workspace/core/storage';
import { BUILDER_CATALOG_KINDS } from '@indx-workspace/contracts/builder';
import { ApiProblemError, createClient } from '@indx-workspace/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as listConnectorsRoute } from '../../../app/api/connectors/route';
import { GET as listEnginesRoute } from '../../../app/api/engines/route';
import { GET as listModelsRoute } from '../../../app/api/model-connections/route';
import { GET as listProfilesRoute } from '../../../app/api/runtime-profiles/route';
import { GET as listSkillsRoute } from '../../../app/api/skills/route';
import { POST as versionsRoute } from '../../../app/api/agents/[id]/versions/route';
import { FIXTURE_PERMISSIONS } from '../../agent-versions/fixtures';
import { createInMemoryAgentVersionStoreProvider } from '../../agent-versions/memory-store';
import { createInMemoryAgentStoreProvider } from '../../agents/memory-store';
import { clearApplicationContext } from '../../application-context';
import { installTestDomains } from '../../application-context-fixtures';
import { createInMemoryConnectorsStoreProvider } from '../../connectors/memory-store';
import { createInMemoryModelsStoreProvider } from '../../models/memory-store';
import { callerHeaders, installRbacHarness } from '../../rbac/testing';
import { createInMemoryCatalogStore } from '../../resources/catalog-store.memory';
import { createInMemoryRuntimeConnectionStoreProvider } from '../../runtimes/connections';
import { createInMemoryRuntimeProfileStoreProvider } from '../../runtimes/memory-store';
import { listSkillsWithIds } from '../../skills/service';
import { importSkill } from '../../skills/handlers';
import { createSkillRowsWorld } from '../../skills/rows-fixture';
import { createAuthorization } from '../adapters/authorization/production';
import { createCatalog } from '../adapters/catalog/production';
import { draftBody } from '../adapters/checker/checker.contract';
import { createChecker } from '../adapters/checker/production';
import { EXAMPLES } from '../examples';
import { makeMemoryPorts } from '../testing/ports';
import { callContextOf } from '../testing/context';
import { handleToolCall } from '../shell';

/**
 * Design §07: a Builder tool answers what the SDK answers for the same workspace, less what the
 * tool deliberately leaves out. Both sides run over the same in-memory stores, the SDK through the
 * real route handlers and the RBAC harness.
 */
const WORKSPACE = crypto.randomUUID();
const OWNER = {
  email: 'owner@example.test',
  name: 'Owner',
  workspaceId: WORKSPACE,
  role: 'owner',
  principalId: crypto.randomUUID(),
} as const;
const ctx = callContextOf(WORKSPACE, 'owner', OWNER.principalId);
const resolveWorkspace = () =>
  Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE } as const);

type Handler = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) => Promise<Response>;

let agentId: string;
let ports: ReturnType<typeof makeMemoryPorts>;
let client: ReturnType<typeof createClient>;

beforeEach(async () => {
  installRbacHarness([OWNER], { workspaceId: WORKSPACE });
  const agents = createInMemoryAgentStoreProvider();
  const created = await agents.forWorkspace(WORKSPACE).create(
    {
      name: 'Support triage',
      instructions: 'Answer support mail.',
      modelConnectionId: null,
      model: null,
      permissions: FIXTURE_PERMISSIONS,
    },
    { principalId: OWNER.principalId, userId: null },
  );
  if (created.kind !== 'created') throw new Error('the memory store creates the fixture agent');
  agentId = created.agent.id;
  const versions = createInMemoryAgentVersionStoreProvider({
    agents,
    references: { [WORKSPACE]: { connector: [{ id: 'c1', name: 'crm' }] } },
  });

  const connectors = createInMemoryConnectorsStoreProvider();
  await connectors.forWorkspace(WORKSPACE).create(
    {
      name: 'crm',
      transport: 'http',
      command: null,
      args: null,
      url: 'https://crm.example.test/mcp?token=abc',
      authType: 'bearer',
      credential: 'sk-live-credential-0001',
    },
    { principalId: OWNER.principalId, userId: null },
  );
  const models = createInMemoryModelsStoreProvider([WORKSPACE]);
  await models.forWorkspace(WORKSPACE).create({
    name: 'Primary',
    provider: 'anthropic-compatible',
    apiKey: 'sk-live-credential-0001',
    config: { baseUrl: 'https://llm.example.test' },
  });
  const runtimeProfiles = createInMemoryRuntimeProfileStoreProvider();
  await runtimeProfiles.forWorkspace(WORKSPACE).create({
    name: 'Standard',
    driver: 'docker',
    runtimeConnectionId: null,
    cpu: 1,
    memoryMb: 1024,
    diskMb: 5120,
    networkPolicy: 'restricted',
    allowedDomains: ['api.anthropic.com'],
    filesystem: 'read-write',
    persistPaths: ['/workspace/output'],
    timeoutSeconds: 3600,
    idleTimeoutSeconds: 600,
    driverConfig: { note: 'default' },
  });
  const objects = createInMemoryObjectStoreProvider();
  const catalog = createInMemoryCatalogStore();
  const skillRows = createSkillRowsWorld(
    createInMemoryObjectStore(),
    WORKSPACE,
    catalog.forWorkspaceSync(WORKSPACE),
    { principalId: OWNER.principalId, userId: null },
  );
  const seeded = await importSkill(
    objects.forWorkspace(WORKSPACE),
    {
      name: 'triage',
      files: [
        {
          path: 'SKILL.md',
          contentBase64: Buffer.from(
            '---\nname: triage\ndescription: Triage.\n---\nBody\n',
          ).toString('base64'),
        },
      ],
    },
    skillRows.rows,
  );
  expect(seeded.status).toBe(201);

  installTestDomains({ agents: { agents, resolveWorkspace } });
  installTestDomains({ agentVersions: { versions } });
  installTestDomains({
    connectors: {
      kind: 'serving',
      runtime: {
        resolveWorkspace,
        connectors,
        recordAudit: () => Promise.resolve(),
        identifyActor: () => Promise.resolve(null),
      },
    },
    models: {
      kind: 'serving',
      runtime: {
        resolveActor: () =>
          Promise.resolve({
            kind: 'workspace',
            workspaceId: WORKSPACE,
            principalId: OWNER.principalId,
            userId: null,
            userLabel: OWNER.name,
            role: 'owner',
            scope: null,
          }),
        models,
        probe: () => Promise.reject(new Error('a list does not probe')),
        discover: () => Promise.reject(new Error('a list does not discover')),
        audit: () => Promise.resolve(),
        log: () => undefined,
      },
    },
    runtimes: {
      kind: 'serving',
      runtime: {
        resolveWorkspace,
        profiles: runtimeProfiles,
        connections: createInMemoryRuntimeConnectionStoreProvider(),
      },
    },
    skills: {
      kind: 'serving',
      runtime: { resolveWorkspace, store: objects, catalog, storage: skillRows.storage },
    },
  });

  ports = makeMemoryPorts({
    catalog: createCatalog({
      connectors,
      models,
      runtimeProfiles,
      skills: async (principal) =>
        listSkillsWithIds(
          objects.forWorkspace(principal.workspaceId),
          await catalog.forWorkspace(principal.workspaceId),
          principal,
          skillRows.rows,
        ),
    }),
    authorization: {
      ...createAuthorization({
        agents,
        versions: { forWorkspace: () => Promise.resolve(null) },
        ceiling: null,
      }),
      creator: () => Promise.resolve({ kind: 'builder' }),
    },
    checker: createChecker({ agents, versions, pipeline: () => ({}) }),
  });

  const routes: Record<string, Handler> = {
    '/api/engines': listEnginesRoute,
    '/api/model-connections': listModelsRoute,
    '/api/connectors': listConnectorsRoute,
    '/api/runtime-profiles': listProfilesRoute,
    '/api/skills': listSkillsRoute,
  };
  client = createClient({
    baseUrl: 'http://web.test',
    auth: { kind: 'session' },
    headers: callerHeaders(OWNER),
    fetch: (input, init) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      const versionsOf = /^\/api\/agents\/([^/]+)\/versions$/u.exec(pathname)?.[1];
      const handler = versionsOf === undefined ? routes[pathname] : versionsRoute;
      if (handler === undefined) return Promise.resolve(new Response(null, { status: 404 }));
      return handler(request, { params: Promise.resolve({ id: versionsOf ?? '' }) });
    },
  });
});

afterEach(clearApplicationContext);

const run = (name: string, args: unknown) =>
  handleToolCall({ name, arguments: args, callId: crypto.randomUUID() }, ctx, ports);

describe('catalog_list against the SDK listings', () => {
  it('lists the SDK rows of every kind as {kind, id, name} and nothing else', async () => {
    const sdk = {
      engines: (await client.engines.list()).map((row) => ({ id: row.id, name: row.displayName })),
      models: (await client.models.connections.list()).map(({ id, name }) => ({ id, name })),
      skills: (await client.skills.list()).map(({ id, name }) => ({ id, name })),
      connectors: (await client.connectors.list()).map(({ id, name }) => ({ id, name })),
      runtimeProfiles: (await client.runtimes.profiles.list()).map(({ id, name }) => ({
        id,
        name,
      })),
    };
    const expected = BUILDER_CATALOG_KINDS.flatMap((kind) =>
      kind === 'files' ? [] : sdk[kind].map((row) => ({ kind, ...row })),
    );

    const result = await run('catalog_list', {});

    expect(result).toMatchObject({ ok: true });
    expect((result as { entries: unknown }).entries).toEqual(expected);
    expect(expected.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(['models', 'skills', 'connectors', 'runtimeProfiles']),
    );
    expect(JSON.stringify(result)).not.toMatch(/sk-live|token=abc|crm\.example/u);
  });
});

describe('draft_check against agents.versions.check', () => {
  const draft = (connectors: readonly string[]) => ({
    summary: 'Builder draft check',
    via: 'api' as const,
    body: draftBody('Draft agent', connectors),
  });

  it('is valid exactly when the SDK dry run answers the version number', async () => {
    const saved = await client.agents.versions.check(agentId, draft(['crm']));
    const result = await run('draft_check', { agentId, body: draft(['crm']).body });
    expect(saved).toMatchObject({ ok: true, number: 1 });
    expect(result).toMatchObject({ ok: true, valid: true, problems: [] });
  });

  it('refuses with the SDK code, message and details, plus the tool fix', async () => {
    const failure: unknown = await client.agents.versions
      .check(agentId, draft(['erp']))
      .catch((error: unknown) => error);
    const result = await run('draft_check', { agentId, body: draft(['erp']).body });
    if (!(failure instanceof ApiProblemError)) throw new Error('expected an ApiProblemError');
    const { code, message, details } = failure;
    expect(result).toMatchObject({ ok: false, code, message, details });
    expect(result).toHaveProperty('fix');
  });
});

describe('examples_get against its source', () => {
  it('lists the gallery names and serves one body unchanged', async () => {
    const [first] = EXAMPLES;
    const result = await run('examples_get', { name: first?.name });
    expect(result).toMatchObject({
      ok: true,
      names: EXAMPLES.map((entry) => entry.name),
      example: { name: first?.name, body: first?.body },
    });
    expect(Object.keys((result as { example: object }).example).sort()).toEqual(['body', 'name']);
  });
});
