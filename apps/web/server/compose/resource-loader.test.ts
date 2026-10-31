import { createHash } from 'node:crypto';

import type { AgentPermissions } from '@agent-workspace/run-protocol';
import {
  createInMemoryWorkspaceScopeResolver,
  type WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import {
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import {
  bytesToStream,
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
  newObjectId,
  storageObjectName,
  streamToBytes,
} from '@agent-workspace/core/storage';
import { RUN_FILES_MAX_BYTES } from '@agent-workspace/runtime/transfer';
import type { AgentResourceAssignments } from '@indx-workspace/contracts/agents';
import { OpenApiToolConfigSchema } from '@indx-workspace/contracts/tool-connectors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  AnyConnectorResource,
  ConnectorResource,
  ToolConnectorResource,
} from '../connectors/contract';
import type { ConnectorsStoreProvider } from '../connectors/store';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { skillPayloadFile, type SkillPayloadFile } from '../skills/fixtures';
import { createSkillRowsWorld, seedBareSkill } from '../skills/rows-fixture';
import { importSkillWithId, patchSkillWithId, publishSkillRevisionWithId } from '../skills/service';
import {
  createResourceCatalogStoreProvider,
  type ResourceCatalogStoreProvider,
} from '../resources/catalog-store';
import { createStorageService, type StorageContext, type StorageService } from '../storage/service';
import {
  assertRunFilesFit,
  createAgentRunResourceLoader,
  skillInboxPath,
  type RunFileSource,
} from './resource-loader';
import { seedCatalogFile } from '@agent-workspace/core/db';
import { listCatalogFiles } from '@agent-workspace/core/db';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const OWNER_PRINCIPAL = '44444444-4444-4444-8444-444444444444';

const sha256Of = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The text a run would receive for `key`, read through the loader's non-serialised sources. */
async function sourceText(
  loaded: { readonly sources?: ReadonlyMap<string, RunFileSource> },
  key: string,
): Promise<string | null> {
  const body = await loaded.sources?.get(key)?.open();
  return body === null || body === undefined
    ? null
    : Buffer.from(await streamToBytes(body)).toString('utf8');
}

function seededId(ids: Record<string, string>, key: string): string {
  const id = ids[key];
  if (id === undefined) throw new Error(`no seeded id for ${key}`);
  return id;
}

/** The catalog service over `catalogs` and an in-memory object store. */
function storageOver(catalogs: ResourceCatalogStoreProvider): StorageService {
  return createStorageService({
    catalog: (workspaceId) => catalogs.forWorkspace(workspaceId),
    objects: createInMemoryObjectStore(),
    log: noLog,
  });
}

/**
 * Saves `paths` through the catalog service, in order (a trailing `/` is a folder); each file holds
 * `texts[path]`, or its own path when none is given. Returns each path's id.
 */
async function seedFiles(
  storage: StorageService,
  paths: readonly string[],
  texts: Readonly<Record<string, string>> = {},
): Promise<Record<string, string>> {
  const ctx: StorageContext = {
    workspaceId: WORKSPACE,
    principalId: OWNER_PRINCIPAL,
    userId: null,
  };
  const ids: Record<string, string> = {};
  for (const entry of paths) {
    const folder = entry.endsWith('/');
    const path = folder ? entry.slice(0, -1) : entry;
    if (folder) {
      const made = await storage.createFolder(ctx, path);
      if (!made.ok) throw new Error(`folder ${path} refused: ${made.code}`);
      ids[path] = made.row.id;
      continue;
    }
    const saved = await storage.save(ctx, {
      area: 'files',
      path,
      body: bytesToStream(new TextEncoder().encode(texts[path] ?? path)),
      maxBytes: 1024,
      replace: true,
    });
    if (!saved.ok) throw new Error(`save ${path} refused: ${saved.code}`);
    ids[path] = saved.row.id;
  }
  return ids;
}

describe('agent run resource loader', () => {
  it('loads only assigned files and enabled skills, and refuses an assigned disabled connector', async () => {
    const assignedConnectorIds = ['connector-enabled'];
    const skillObjects = createInMemoryObjectStoreProvider();
    await skillObjects
      .forWorkspace(WORKSPACE)
      .write('skills/enabled/SKILL.md', Buffer.from('# enabled'), {});
    await skillObjects
      .forWorkspace(WORKSPACE)
      .write('skills/disabled/SKILL.md', Buffer.from('# disabled'), {});
    await skillObjects
      .forWorkspace(WORKSPACE)
      .write('skills/unassigned/SKILL.md', Buffer.from('# unassigned'), {});

    const catalogs = createInMemoryCatalogStore();
    const catalog = catalogs.forWorkspaceSync(WORKSPACE);
    const storage = storageOver(catalogs);
    const fileIds = await seedFiles(storage, ['assigned.txt', 'unassigned.txt'], {
      'assigned.txt': 'assigned',
      'unassigned.txt': 'unassigned',
    });
    const skillIds: Record<'enabled' | 'disabled' | 'unassigned', string> = {
      enabled: '',
      disabled: '',
      unassigned: '',
    };
    for (const name of ['enabled', 'disabled', 'unassigned'] as const) {
      skillIds[name] = (
        await catalog.putSkill({
          name,
          skillMd: `# ${name}`,
          enabled: name !== 'disabled',
          ownerPrincipalId: OWNER_PRINCIPAL,
          createdBy: 'test-owner',
        })
      ).id;
    }

    const connectorRows = new Map([
      ['connector-enabled', { name: 'Assigned Connector', enabled: true }],
      ['connector-disabled', { name: 'disabled-connector', enabled: false }],
      ['connector-unassigned', { name: 'unassigned-connector', enabled: true }],
    ]);
    const connectors: ConnectorsStoreProvider = {
      forWorkspace() {
        return {
          list: () => Promise.resolve([]),
          get(id) {
            const row = connectorRows.get(id);
            return Promise.resolve(
              row === undefined
                ? null
                : {
                    id,
                    workspaceId: WORKSPACE,
                    name: row.name,
                    transport: 'http',
                    command: null,
                    args: null,
                    url: 'https://mcp.example.test',
                    authType: 'none',
                    hasCredential: false,
                    enabled: row.enabled,
                    ownerPrincipalId: OWNER_PRINCIPAL,
                    createdBy: 'test-owner',
                    createdAt: new Date(0).toISOString(),
                    updatedAt: new Date(0).toISOString(),
                  },
            );
          },
          create: () => Promise.reject(new Error('unused')),
          delete: () => Promise.reject(new Error('unused')),
          rotateCredential: () => Promise.reject(new Error('unused')),
          update: () => Promise.reject(new Error('unused')),
          createToolConnector: () => Promise.reject(new Error('unused')),
          replaceToolConnector: () => Promise.reject(new Error('unused')),
          openapiDocument: () => Promise.reject(new Error('unused')),
          resolveIdentityKey: () => Promise.resolve(undefined),
          resolveForProbe: (id) =>
            Promise.resolve(
              connectorRows.has(id)
                ? {
                    transport: 'http',
                    url: 'https://mcp.example.test',
                    headers: {},
                    credentialConfigured: false,
                  }
                : null,
            ),
        };
      },
    };
    const assigned = (): AgentResourceAssignments => ({
      files: [{ fileId: seededId(fileIds, 'assigned.txt'), access: 'read' }],
      skillIds: [skillIds.enabled, skillIds.disabled],
      connectorIds: [...assignedConnectorIds],
      storageGrants: [],
    });
    const loader = createAgentRunResourceLoader({
      catalog: catalogs,
      storage,
      skills: skillObjects,
      connectors,
    });

    const loaded = await loader.load(WORKSPACE, assigned());
    expect(loaded.files).toEqual([
      { kind: 'file', path: 'assigned.txt', access: 'read', size: 8, sha256: sha256Of('assigned') },
    ]);
    expect(await sourceText(loaded, 'assigned.txt')).toBe('assigned');
    expect(loaded.skills.map((skill) => skill.name)).toEqual(['enabled']);
    expect(Object.keys(loaded.mcpServers)).toEqual(['connector-connector-enabled']);
    expect(JSON.stringify(loaded)).not.toContain('unassigned');
    expect(JSON.stringify(loaded)).not.toContain('disabled');

    // #240: a disabled connector the agent still has assigned fails the run with a stable code
    // instead of being dropped from it.
    assignedConnectorIds.push('connector-disabled');
    await expect(loader.load(WORKSPACE, assigned())).rejects.toMatchObject({
      code: 'connector_disabled',
      publicMessage: expect.stringMatching(/^connector_disabled: /u) as unknown,
    });
  });

  it('applies explicit child-folder permissions recursively with the most specific grant winning', async () => {
    const catalogs = createInMemoryCatalogStore();
    const storage = storageOver(catalogs);
    const ids = await seedFiles(storage, [
      'root/',
      'root/loose.txt',
      'root/restricted/',
      'root/restricted/a.txt',
      'root/restricted/deeper/',
      'root/restricted/deeper/exception.txt',
    ]);
    const assigned = (): AgentResourceAssignments => ({
      files: [
        { fileId: seededId(ids, 'root'), access: 'read-write' },
        { fileId: seededId(ids, 'root/restricted'), access: 'read' },
        { fileId: seededId(ids, 'root/restricted/deeper/exception.txt'), access: 'read-write' },
      ],
      skillIds: [],
      connectorIds: [],
      storageGrants: [],
    });
    const loader = createAgentRunResourceLoader({ catalog: catalogs, storage });

    const loaded = await loader.load(WORKSPACE, assigned());
    expect(loaded.files.map(({ path, access }) => [path, access])).toEqual([
      ['root', 'read-write'],
      ['root/loose.txt', 'read-write'],
      ['root/restricted', 'read'],
      ['root/restricted/a.txt', 'read'],
      ['root/restricted/deeper', 'read'],
      ['root/restricted/deeper/exception.txt', 'read-write'],
    ]);
  });

  it('[US-STO-02][unit][sdk] a folder grant skips a pending child upload and an object without a row', async () => {
    const objects = createInMemoryObjectStore();
    const catalogs = createInMemoryCatalogStore();
    const catalog = catalogs.forWorkspaceSync(WORKSPACE);
    const storage = createStorageService({
      catalog: (workspaceId) => catalogs.forWorkspace(workspaceId),
      objects,
      log: noLog,
    });
    const ids = await seedFiles(storage, ['docs/', 'docs/ready.txt']);
    await catalog.reserve('docs/pending.txt', {
      objectId: crypto.randomUUID(),
      ownerPrincipalId: OWNER_PRINCIPAL,
      sizeBytes: 10,
      contentType: 'text/plain',
    });
    // An object no row names, as a store listing would show it.
    await objects.write(
      storageObjectName(WORKSPACE, 'files', newObjectId()),
      Buffer.from('legacy'),
      {},
    );
    const loader = createAgentRunResourceLoader({ catalog: catalogs, storage });

    const loaded = await loader.load(WORKSPACE, {
      files: [{ fileId: seededId(ids, 'docs'), access: 'read' }],
      skillIds: [],
      connectorIds: [],
      storageGrants: [],
    });
    // A run reads ready catalog rows only: an object without one has no checksum to reference.
    expect(loaded.files.map(({ path }) => path)).toEqual(['docs', 'docs/ready.txt']);
  });

  it('rejects mixed-case aliases of the runner private directory from legacy catalogs', async () => {
    const catalogs = createInMemoryCatalogStore();
    const storage = storageOver(catalogs);
    // A row from before the guard existed, so the service would refuse to write it today.
    const row = await seedCatalogFile(catalogs.forWorkspaceSync(WORKSPACE), {
      path: '.ClAuDe/settings.json',
      kind: 'file',
      sizeBytes: 2,
      contentType: 'application/json',
      ownerPrincipalId: OWNER_PRINCIPAL,
      createdBy: 'test-owner',
    });
    const ids = { '.ClAuDe/settings.json': row.id };
    const assigned = (): AgentResourceAssignments => ({
      files: [{ fileId: seededId(ids, '.ClAuDe/settings.json'), access: 'read-write' }],
      skillIds: [],
      connectorIds: [],
      storageGrants: [],
    });
    const loader = createAgentRunResourceLoader({ catalog: catalogs, storage });

    await expect(loader.load(WORKSPACE, assigned())).rejects.toThrow(/private \.claude directory/u);
  });
});

describe('agent run resource loader — project associations (issue #125)', () => {
  const PROJECT = '55555555-5555-4555-8555-555555555555';
  const ALL_ON: AgentPermissions = {
    readFiles: true,
    writeFiles: true,
    runCommands: true,
    unrestrictedNetwork: true,
  };
  const ALL_OFF: AgentPermissions = {
    readFiles: false,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: false,
  };

  /** An assignments/catalog/files fixture with one project-only folder and one agent-only file. */
  async function fixture(
    agentFiles: readonly { path: string; access: 'read' | 'read-write' }[],
    mine = 'mine',
  ) {
    const catalog = createInMemoryCatalogStore();
    const storage = storageOver(catalog);
    const ids = await seedFiles(storage, ['shared/', 'shared/mine.txt'], {
      'shared/mine.txt': mine,
    });
    return {
      storage,
      folderId: seededId(ids, 'shared'),
      fileId: seededId(ids, 'shared/mine.txt'),
      assignments: {
        files: agentFiles.map(({ path, access }) => ({ fileId: seededId(ids, path), access })),
        skillIds: [],
        connectorIds: [],
        storageGrants: [],
      },
      catalog,
    };
  }

  it('composes a project folder association into the run when the agent has read-file permission', async () => {
    const { storage, assignments, catalog, folderId } = await fixture([]);
    const loader = createAgentRunResourceLoader({
      catalog,
      storage,
      projectResources: {
        listFileIds: () => Promise.resolve([folderId]),
        listMcpServerIds: () => Promise.resolve([]),
      },
    });

    const loaded = await loader.load(WORKSPACE, assignments, PROJECT, ALL_ON);
    expect(loaded.files.map(({ path, access }) => [path, access])).toEqual([
      ['shared', 'read'],
      ['shared/mine.txt', 'read'],
    ]);
  });

  it("refuses — rather than silently dropping — a project folder the agent's own readFiles permission does not reach", async () => {
    const { storage, assignments, catalog, folderId } = await fixture([]);
    const loader = createAgentRunResourceLoader({
      catalog,
      storage,
      projectResources: {
        listFileIds: () => Promise.resolve([folderId]),
        listMcpServerIds: () => Promise.resolve([]),
      },
    });

    // Verifier attack #1: the agent has no file permission for the project's folder association.
    await expect(loader.load(WORKSPACE, assignments, PROJECT, ALL_OFF)).rejects.toThrow(
      /readFiles tool permission/u,
    );
    // Omitting permissions entirely is the same refusal, not an accidental pass.
    await expect(loader.load(WORKSPACE, assignments, PROJECT)).rejects.toThrow(
      /readFiles tool permission/u,
    );
  });

  it("the agent's own explicit grant on the same file id wins over the project's, mode included", async () => {
    const { storage, assignments, catalog, fileId } = await fixture(
      [{ path: 'shared/mine.txt', access: 'read-write' }],
      'abc',
    );
    const loader = createAgentRunResourceLoader({
      catalog,
      storage,
      // The project also associates the exact same file the agent already has read-write on.
      projectResources: {
        listFileIds: () => Promise.resolve([fileId]),
        listMcpServerIds: () => Promise.resolve([]),
      },
    });

    const loaded = await loader.load(WORKSPACE, assignments, PROJECT, ALL_ON);
    expect(loaded.files).toEqual([
      {
        kind: 'file',
        path: 'shared/mine.txt',
        access: 'read-write',
        size: 3,
        sha256: sha256Of('abc'),
      },
    ]);
  });

  /** One project-associated connector, `connector-shared`, enabled or not. */
  function sharedConnector(enabled: boolean): ConnectorsStoreProvider {
    const connectorRows = new Map([['connector-shared', { name: 'shared-connector', enabled }]]);
    return {
      forWorkspace() {
        return {
          list: () => Promise.resolve([]),
          get(id) {
            const row = connectorRows.get(id);
            return Promise.resolve(
              row === undefined
                ? null
                : {
                    id,
                    workspaceId: WORKSPACE,
                    name: row.name,
                    transport: 'http',
                    command: null,
                    args: null,
                    url: 'https://mcp.example.test',
                    authType: 'none',
                    hasCredential: false,
                    enabled: row.enabled,
                    ownerPrincipalId: OWNER_PRINCIPAL,
                    createdBy: 'test-owner',
                    createdAt: new Date(0).toISOString(),
                    updatedAt: new Date(0).toISOString(),
                  },
            );
          },
          create: () => Promise.reject(new Error('unused')),
          delete: () => Promise.reject(new Error('unused')),
          rotateCredential: () => Promise.reject(new Error('unused')),
          update: () => Promise.reject(new Error('unused')),
          createToolConnector: () => Promise.reject(new Error('unused')),
          replaceToolConnector: () => Promise.reject(new Error('unused')),
          openapiDocument: () => Promise.reject(new Error('unused')),
          resolveIdentityKey: () => Promise.resolve(undefined),
          resolveForProbe: (id) =>
            Promise.resolve(
              connectorRows.has(id)
                ? {
                    transport: 'http',
                    url: 'https://mcp.example.test',
                    headers: {},
                    credentialConfigured: false,
                  }
                : null,
            ),
        };
      },
    };
  }

  it('refuses a project connector association when the agent lacks unrestrictedNetwork, and includes it when granted', async () => {
    const { assignments, catalog } = await fixture([]);
    const connectors = sharedConnector(true);
    const loader = createAgentRunResourceLoader({
      catalog,
      connectors,
      projectResources: {
        listFileIds: () => Promise.resolve([]),
        listMcpServerIds: () => Promise.resolve(['connector-shared']),
      },
    });

    await expect(loader.load(WORKSPACE, assignments, PROJECT, ALL_OFF)).rejects.toThrow(
      /unrestrictedNetwork tool permission/u,
    );

    const loaded = await loader.load(WORKSPACE, assignments, PROJECT, ALL_ON);
    expect(Object.keys(loaded.mcpServers)).toEqual(['shared-connector']);
  });

  it('fails the run on a disabled project-associated connector, naming the project as a source (#240)', async () => {
    const { assignments, catalog } = await fixture([]);
    const loader = createAgentRunResourceLoader({
      catalog,
      connectors: sharedConnector(false),
      projectResources: {
        listFileIds: () => Promise.resolve([]),
        listMcpServerIds: () => Promise.resolve(['connector-shared']),
      },
    });

    // Refused, not dropped, exactly as for an agent's own assignment; the message points at both
    // places a connector can come from, since unassigning it from the agent would not help here.
    await expect(loader.load(WORKSPACE, assignments, PROJECT, ALL_ON)).rejects.toMatchObject({
      code: 'connector_disabled',
      publicMessage: expect.stringMatching(
        /^connector_disabled: .*connector-shared is disabled; .*the agent or the project/u,
      ) as unknown,
    });
  });

  it('omitting a project id loads no project resource at all, even when a reader is configured', async () => {
    const { storage, assignments, catalog } = await fixture([]);
    const loader = createAgentRunResourceLoader({
      catalog,
      storage,
      projectResources: {
        listFileIds: () => Promise.reject(new Error('must not be called without a project id')),
        listMcpServerIds: () =>
          Promise.reject(new Error('must not be called without a project id')),
      },
    });

    await expect(loader.load(WORKSPACE, assignments)).resolves.toEqual({
      files: [],
      skills: [],
      sources: new Map(),
      mcpServers: {},
    });
  });
});

describe('agent run resource loader — tool connectors (S2-02f, #531)', () => {
  const PROJECT = '55555555-5555-4555-8555-555555555555';
  const ALL_ON: AgentPermissions = {
    readFiles: true,
    writeFiles: true,
    runCommands: true,
    unrestrictedNetwork: true,
  };
  const ALL_OFF: AgentPermissions = {
    readFiles: false,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: false,
  };
  const ORDERS_LOW = '00000000-0000-4000-8000-00000000000a';
  const ORDERS_HIGH = '00000000-0000-4000-8000-00000000000b';
  const POSTGRES = '00000000-0000-4000-8000-00000000000c';
  const MCP = '00000000-0000-4000-8000-00000000000d';
  const PROJECT_MCP = '00000000-0000-4000-8000-00000000000f';

  const openapi = (auth: 'none' | 'bearer') =>
    OpenApiToolConfigSchema.parse({
      spec: { digest: `sha256:${'0'.repeat(64)}`, bytes: 10 },
      baseUrl: 'https://orders.example.test',
      auth,
      allow: ['GET /orders/*'],
      operations: [{ name: 'getOrder', method: 'GET', path: '/orders/{id}' }],
    });

  function toolConnector(
    id: string,
    name: string,
    half: Pick<ToolConnectorResource, 'kind' | 'openapi' | 'postgres'>,
    overrides: Partial<Pick<ToolConnectorResource, 'enabled' | 'hasCredential'>> = {},
  ): ToolConnectorResource {
    return {
      id,
      workspaceId: WORKSPACE,
      name,
      transport: null,
      command: null,
      args: null,
      url: null,
      authType: null,
      hasCredential: false,
      enabled: true,
      createdBy: null,
      ownerPrincipalId: OWNER_PRINCIPAL,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      ...half,
      ...overrides,
    };
  }

  const mcpConnector: ConnectorResource = {
    id: MCP,
    workspaceId: WORKSPACE,
    name: 'github',
    transport: 'http',
    command: null,
    args: null,
    url: 'https://mcp.example.test',
    authType: 'none',
    hasCredential: false,
    enabled: true,
    ownerPrincipalId: OWNER_PRINCIPAL,
    createdBy: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };

  /** A store holding `rows`; only MCP connectors have a probe, as in the real store. */
  function connectorsOf(rows: readonly AnyConnectorResource[]): ConnectorsStoreProvider {
    const byId = new Map(rows.map((row) => [row.id, row]));
    return {
      forWorkspace() {
        return {
          list: () => Promise.resolve([...rows]),
          get: (id) => Promise.resolve(byId.get(id) ?? null),
          create: () => Promise.reject(new Error('unused')),
          delete: () => Promise.reject(new Error('unused')),
          rotateCredential: () => Promise.reject(new Error('unused')),
          update: () => Promise.reject(new Error('unused')),
          createToolConnector: () => Promise.reject(new Error('unused')),
          replaceToolConnector: () => Promise.reject(new Error('unused')),
          openapiDocument: () => Promise.reject(new Error('unused')),
          resolveIdentityKey: () => Promise.resolve(undefined),
          resolveForProbe: (id) =>
            Promise.resolve(
              byId.get(id)?.kind === undefined && byId.has(id)
                ? {
                    transport: 'http',
                    url: 'https://mcp.example.test',
                    headers: {},
                    credentialConfigured: false,
                  }
                : null,
            ),
        };
      },
    };
  }

  function loaderFor(
    rows: readonly AnyConnectorResource[],
    connectorIds: readonly string[],
    projectConnectorIds: readonly string[] = [],
  ) {
    const loader = createAgentRunResourceLoader({
      catalog: {
        forWorkspace: () => Promise.reject(new Error('unused')),
      },
      connectors: connectorsOf(rows),
      projectResources: {
        listFileIds: () => Promise.resolve([]),
        listMcpServerIds: () => Promise.resolve([...projectConnectorIds]),
      },
    });
    const assignments = {
      files: [],
      skillIds: [],
      connectorIds: [...connectorIds],
      storageGrants: [],
    };
    return {
      load: (
        workspaceId: string,
        projectId: string | null = null,
        permissions?: AgentPermissions,
      ) => loader.load(workspaceId, assignments, projectId, permissions),
    };
  }

  it('returns an openapi connector as a pending entry keyed by its SD13 key, not connector-<uuid>', async () => {
    const loaded = await loaderFor(
      [toolConnector(ORDERS_LOW, 'Orders', { kind: 'openapi', openapi: openapi('none') })],
      [ORDERS_LOW],
    ).load(WORKSPACE);
    expect(loaded.mcpServers).toEqual({});
    expect(loaded.toolConnectors).toEqual([
      { key: 'orders', connectorId: ORDERS_LOW, name: 'Orders', operationNames: ['getOrder'] },
    ]);
  });

  it('carries the approval rule of each write operation under the SD13 key (ADR-0113 SD4)', async () => {
    const writes = OpenApiToolConfigSchema.parse({
      spec: { digest: `sha256:${'0'.repeat(64)}`, bytes: 10 },
      baseUrl: 'https://orders.example.test',
      auth: 'none',
      allow: ['GET /orders/*', 'POST /orders'],
      operations: [
        { name: 'getOrder', method: 'GET', path: '/orders/{id}' },
        { name: 'createOrder', method: 'POST', path: '/orders' },
      ],
    });
    const loaded = await loaderFor(
      [
        toolConnector(ORDERS_HIGH, 'Orders', { kind: 'openapi', openapi: writes }),
        toolConnector(ORDERS_LOW, 'orders', { kind: 'openapi', openapi: writes }),
      ],
      [ORDERS_HIGH, ORDERS_LOW],
    ).load(WORKSPACE);
    expect(loaded.toolConnectors?.map(({ key, approvalRules }) => [key, approvalRules])).toEqual([
      ['orders', ['mcp__orders__createOrder']],
      ['orders_2', ['mcp__orders_2__createOrder']],
    ]);
  });

  it('keys two connectors named orders and Orders as orders and orders_2, in id order', async () => {
    const loaded = await loaderFor(
      [
        toolConnector(ORDERS_HIGH, 'Orders', { kind: 'openapi', openapi: openapi('none') }),
        toolConnector(ORDERS_LOW, 'orders', { kind: 'openapi', openapi: openapi('none') }),
      ],
      [ORDERS_HIGH, ORDERS_LOW],
    ).load(WORKSPACE);
    expect(loaded.toolConnectors?.map(({ key, connectorId }) => [key, connectorId])).toEqual([
      ['orders', ORDERS_LOW],
      ['orders_2', ORDERS_HIGH],
    ]);
  });

  it("names a postgres connector's three operations, and keeps an MCP connector's config unchanged", async () => {
    const loaded = await loaderFor(
      [
        mcpConnector,
        toolConnector(
          POSTGRES,
          'Warehouse DB',
          {
            kind: 'postgres',
            postgres: { tables: ['public.orders'], readOnly: true, maxRows: 100 },
          },
          { hasCredential: true },
        ),
      ],
      [MCP, POSTGRES],
    ).load(WORKSPACE);
    expect(loaded.mcpServers).toEqual({
      github: { type: 'http', url: 'https://mcp.example.test' },
    });
    expect(loaded.toolConnectors).toEqual([
      {
        key: 'warehouse_db',
        connectorId: POSTGRES,
        name: 'Warehouse DB',
        operationNames: ['list_tables', 'describe', 'select'],
      },
    ]);
  });

  it('refuses a disabled tool connector with connector_disabled (#240)', async () => {
    await expect(
      loaderFor(
        [
          toolConnector(
            ORDERS_LOW,
            'Orders',
            { kind: 'openapi', openapi: openapi('none') },
            { enabled: false },
          ),
        ],
        [ORDERS_LOW],
      ).load(WORKSPACE),
    ).rejects.toMatchObject({ code: 'connector_disabled' });
  });

  it('refuses a postgres or authenticated openapi connector with no credential, naming it', async () => {
    const postgres = toolConnector(POSTGRES, 'Warehouse DB', {
      kind: 'postgres',
      postgres: { tables: ['public.orders'], readOnly: true, maxRows: 100 },
    });
    await expect(loaderFor([postgres], [POSTGRES]).load(WORKSPACE)).rejects.toThrow(
      /"Warehouse DB" has no resolvable credential/u,
    );
    const orders = toolConnector(ORDERS_LOW, 'Orders', {
      kind: 'openapi',
      openapi: openapi('bearer'),
    });
    await expect(loaderFor([orders], [ORDERS_LOW]).load(WORKSPACE)).rejects.toThrow(
      /"Orders" has no resolvable credential/u,
    );
  });

  it('refuses a tool connector a project binds (#586), after the unrestrictedNetwork ceiling (#125)', async () => {
    const rows = [
      toolConnector(ORDERS_LOW, 'Orders', { kind: 'openapi', openapi: openapi('none') }),
    ];
    await expect(
      loaderFor(rows, [], [ORDERS_LOW]).load(WORKSPACE, PROJECT, ALL_OFF),
    ).rejects.toThrow(/unrestrictedNetwork tool permission/u);
    await expect(
      loaderFor(rows, [], [ORDERS_LOW]).load(WORKSPACE, PROJECT, ALL_ON),
    ).rejects.toMatchObject({ code: 'project_connector_not_mcp' });
    // The agent's own assignment of the same connector is the agent's, whatever the project says.
    const loaded = await loaderFor(rows, [ORDERS_LOW], [ORDERS_LOW]).load(
      WORKSPACE,
      PROJECT,
      ALL_ON,
    );
    expect(loaded.toolConnectors?.map(({ key }) => key)).toEqual(['orders']);
  });

  it('names the connector behind each MCP key, for an agent and a project connector (S2-04c)', async () => {
    const projectMcp = { ...mcpConnector, id: PROJECT_MCP, name: 'jira' };
    const loaded = await loaderFor([mcpConnector, projectMcp], [MCP], [PROJECT_MCP]).load(
      WORKSPACE,
      PROJECT,
      ALL_ON,
    );
    expect(loaded.connectorNames).toEqual({ github: 'github', jira: 'jira' });
    expect(Object.keys(loaded.mcpServers).sort()).toEqual(
      Object.keys(loaded.connectorNames ?? {}).sort(),
    );
  });

  it('keys an MCP connector by its slug name and records the key by id (#1109)', async () => {
    const projectMcp = { ...mcpConnector, id: PROJECT_MCP, name: 'file-finder' };
    const loaded = await loaderFor([mcpConnector, projectMcp], [MCP], [PROJECT_MCP]).load(
      WORKSPACE,
      PROJECT,
      ALL_ON,
    );
    expect(Object.keys(loaded.mcpServers)).toEqual(['file-finder', 'github']);
    expect(loaded.connectorKeys).toEqual({ [MCP]: 'github', [PROJECT_MCP]: 'file-finder' });
  });

  it('keys an MCP connector connector-<id> when its name is not a slug (#1109)', async () => {
    const loaded = await loaderFor([{ ...mcpConnector, name: 'Assigned Connector' }], [MCP]).load(
      WORKSPACE,
    );
    expect(Object.keys(loaded.mcpServers)).toEqual([`connector-${MCP}`]);
    expect(loaded.connectorNames).toEqual({ [`connector-${MCP}`]: 'Assigned Connector' });
    expect(loaded.connectorKeys).toEqual({ [MCP]: `connector-${MCP}` });
  });

  it('gives the tool connector its SD13 key and the colliding MCP connector its id (#1109)', async () => {
    const loaded = await loaderFor(
      [
        { ...mcpConnector, name: 'orders' },
        toolConnector(ORDERS_LOW, 'Orders', { kind: 'openapi', openapi: openapi('none') }),
      ],
      [MCP, ORDERS_LOW],
    ).load(WORKSPACE);
    expect(loaded.toolConnectors?.map(({ key }) => key)).toEqual(['orders']);
    expect(Object.keys(loaded.mcpServers)).toEqual([`connector-${MCP}`]);
    expect(loaded.connectorNames).toEqual({ [`connector-${MCP}`]: 'orders' });
  });
});

describe('a pinned skill revision (SDK-19, N-1)', () => {
  const PRINCIPAL = { ownerPrincipalId: OWNER_PRINCIPAL, userId: null, workspaceId: WORKSPACE };
  const skillMd = (body: string): SkillPayloadFile =>
    skillPayloadFile('SKILL.md', `---\nname: triage\n---\n${body}\n`);

  const file = skillPayloadFile;

  async function setup() {
    const skills = createInMemoryObjectStoreProvider();
    const store = skills.forWorkspace(WORKSPACE);
    const catalogs = createInMemoryCatalogStore();
    const repository = catalogs.forWorkspaceSync(WORKSPACE);
    const { rows, storage } = createSkillRowsWorld(
      createInMemoryObjectStore(),
      WORKSPACE,
      repository,
    );

    const imported = await importSkillWithId(
      store,
      repository,
      PRINCIPAL,
      { name: 'triage', files: [skillMd('v0')] },
      rows,
    );
    expect(imported.status).toBe(201);
    const skillId = (await repository.listSkills()).find((skill) => skill.name === 'triage')?.id;
    if (skillId === undefined) throw new Error('no catalog row for the imported skill');
    const publish = async (files: SkillPayloadFile[]): Promise<void> => {
      const published = await publishSkillRevisionWithId(
        store,
        repository,
        PRINCIPAL,
        'triage',
        { files },
        rows,
      );
      expect(published.status, JSON.stringify(published.body)).toBe(201);
    };
    const loader = createAgentRunResourceLoader({ catalog: catalogs, skills, storage });
    // What a run composed from this assignment would materialise: path -> text.
    const loadedFiles = async (
      skillRevisions?: Record<string, number>,
    ): Promise<Record<string, string>> => {
      const loaded = await loader.load(WORKSPACE, {
        files: [],
        skillIds: [skillId],
        connectorIds: [],
        storageGrants: [],
        ...(skillRevisions === undefined ? {} : { skillRevisions }),
      });
      const entries = await Promise.all(
        (loaded.skills[0]?.files ?? []).map(async (entry): Promise<[string, string]> => [
          entry.path,
          (await sourceText(loaded, skillInboxPath('triage', entry.path))) ?? '',
        ]),
      );
      return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
    };
    return { store, repository, rows, publish, loadedFiles, skillId };
  }

  it('keeps loading revision 2 after the skill is patched, while an unpinned agent follows the patch', async () => {
    const { store, repository, rows, publish, loadedFiles, skillId } = await setup();
    await publish([skillMd('v1')]);
    await publish([skillMd('v2')]);
    const patched = await patchSkillWithId(
      store,
      repository,
      PRINCIPAL,
      'triage',
      { files: [skillMd('patched')] },
      rows,
    );
    expect(patched.status).toBe(200);

    expect((await loadedFiles({ [skillId]: 2 }))['SKILL.md']).toContain('v2');
    expect((await loadedFiles({ [skillId]: 1 }))['SKILL.md']).toContain('v1');
    expect((await loadedFiles())['SKILL.md']).toContain('patched');
  });

  it("loads exactly revision N's files for a pinned run, still after N+1 is published, while latest follows N+1", async () => {
    const { publish, loadedFiles, skillId } = await setup();
    await publish([skillMd('first'), file('notes/guide.md', 'guide for one')]);
    const pinned = { [skillId]: 1 };
    const before = await loadedFiles(pinned);
    expect(Object.keys(before).sort()).toEqual(['SKILL.md', 'notes/guide.md']);
    expect(before['SKILL.md']).toContain('first');
    expect(before['notes/guide.md']).toBe('guide for one');
    expect(await loadedFiles()).toEqual(before);

    await publish([skillMd('second'), file('extra.txt', 'only in two')]);

    // The run pinned to 1 loads the same files and bytes it did before 2 existed.
    expect(await loadedFiles(pinned)).toEqual(before);
    // `latest` (no pin) now follows revision 2, and a pin to 2 loads the same set.
    const latest = await loadedFiles();
    expect(Object.keys(latest).sort()).toEqual(['SKILL.md', 'extra.txt']);
    expect(latest['SKILL.md']).toContain('second');
    expect(await loadedFiles({ [skillId]: 2 })).toEqual(latest);
  });
});

interface Member {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string | null;
}

interface World {
  readonly catalogs: ResourceCatalogStoreProvider;
  readonly scopes: WorkspaceScopeResolver;
  readonly a: Member;
  readonly b: Member;
}

const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

function memoryWorld(): Promise<World> {
  const a = { workspaceId: crypto.randomUUID(), principalId: crypto.randomUUID(), userId: null };
  const b = { workspaceId: crypto.randomUUID(), principalId: crypto.randomUUID(), userId: null };
  return Promise.resolve({
    catalogs: createInMemoryCatalogStore(),
    scopes: createInMemoryWorkspaceScopeResolver([
      { id: a.workspaceId, slug: 'acme' },
      { id: b.workspaceId, slug: 'globex' },
    ]),
    a,
    b,
  });
}

let isolated: IsolatedTestDatabase | undefined;

async function postgresMember(db: IsolatedTestDatabase['db']): Promise<Member> {
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'files' });
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Member' });
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
  });
  return { workspaceId, principalId, userId };
}

async function postgresWorld(): Promise<World> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const scopes = createDatabaseWorkspaceScopeResolver(isolated.db);
  return {
    catalogs: createResourceCatalogStoreProvider({
      repositories: createDatabaseResourceCatalogRepositoryProvider(isolated.db),
      scopes,
    }),
    scopes,
    a: await postgresMember(isolated.db),
    b: await postgresMember(isolated.db),
  };
}

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL']?.trim();
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set; run this suite through `pnpm test`.');
  }
  isolated = await createIsolatedTestDatabase('aw_resource_loader');
}, 180_000);

afterAll(async () => isolated?.close());

const ctxOf = (member: Member): StorageContext => ({
  workspaceId: member.workspaceId,
  principalId: member.principalId,
  userId: member.userId,
});

function defineCatalogSuite(name: string, setup: () => Promise<World>) {
  describe(`agent run resource loader through the catalog service on the ${name}`, () => {
    // @story US-STO-06
    it('[US-STO-06][unit][run] grants become references with size and checksum', async () => {
      const world = await setup();
      const storage = createStorageService({
        catalog: (workspaceId) => world.catalogs.forWorkspace(workspaceId),
        objects: createInMemoryObjectStore(),
        log: noLog,
      });
      const saved = await storage.save(ctxOf(world.a), {
        area: 'files',
        path: 'reports/q3.txt',
        maxBytes: 1024,
        replace: true,
        body: bytesToStream(bytesOf('quarterly numbers')),
      });
      if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
      const opened: unknown[] = [];
      const loader = createAgentRunResourceLoader({
        catalog: world.catalogs,
        storage: {
          ...storage,
          open: (ctx, row, range) => {
            opened.push(ctx);
            return storage.open(ctx, row, range);
          },
        },
      });

      const loaded = await loader.load(world.a.workspaceId, {
        files: [{ fileId: saved.row.id, access: 'read' }],
        skillIds: [],
        connectorIds: [],
      });
      expect(loaded.files).toEqual([
        {
          kind: 'file',
          path: 'reports/q3.txt',
          access: 'read',
          size: 17,
          sha256: sha256Of('quarterly numbers'),
        },
      ]);
      // References only: nothing was read while loading, and no byte is in what is serialised.
      expect(opened).toEqual([]);
      expect(JSON.stringify(loaded)).not.toContain('quarterly');
      expect(await sourceText(loaded, 'reports/q3.txt')).toBe('quarterly numbers');
      // A run opens its input with no actor, so no download audit row is written.
      expect(opened).toEqual([{ workspaceId: world.a.workspaceId }]);
    });

    // @story US-STO-06
    it('[US-STO-06][unit][run] total over the cap is refused', async () => {
      const world = await setup();
      const catalog = await world.catalogs.forWorkspace(world.a.workspaceId);
      const half = RUN_FILES_MAX_BYTES / 2;
      const ids: string[] = [];
      // Rows only, no objects: the refusal must come before any byte is read.
      for (const path of ['big/a.bin', 'big/b.bin']) {
        const reserved = await catalog.reserve(path, {
          ownerPrincipalId: world.a.principalId,
          sizeBytes: half,
          contentType: null,
          objectId: newObjectId(),
        });
        if (reserved.kind !== 'reserved') throw new Error(`${path} was not reserved`);
        const confirmed = await catalog.confirm(reserved.row, {
          sizeBytes: path === 'big/a.bin' ? half : half + 1,
          contentType: null,
          sha256: sha256Of(path),
        });
        if (confirmed === null) throw new Error(`${path} did not confirm`);
        ids.push(confirmed.row.id);
      }
      const loader = createAgentRunResourceLoader({
        catalog: world.catalogs,
        storage: createStorageService({
          catalog: (workspaceId) => world.catalogs.forWorkspace(workspaceId),
          objects: createInMemoryObjectStore(),
          log: noLog,
        }),
      });
      const load = (fileIds: readonly string[]) =>
        loader.load(world.a.workspaceId, {
          files: fileIds.map((fileId) => ({ fileId, access: 'read' as const })),
          skillIds: [],
          connectorIds: [],
        });

      // Loading judges nothing: a run's fileScope may still narrow the grants (issue #1539).
      const both = await load(ids);
      let refusal: unknown = null;
      try {
        assertRunFilesFit(both.files, both.skills);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toMatchObject({
        code: 'run_files_too_large',
        publicMessage: `run_files_too_large: the run's files total ${String(RUN_FILES_MAX_BYTES + 1)} bytes, over the limit of ${String(RUN_FILES_MAX_BYTES)} bytes. Grant fewer or smaller files.`,
      });
      // One of them alone is under the limit.
      const one = await load(ids.slice(0, 1));
      expect(one.files).toMatchObject([{ path: 'big/a.bin', size: half }]);
      expect(() => assertRunFilesFit(one.files, one.skills)).not.toThrow();
    });

    /** A catalog service over `world`, and a ready `docs` folder row to grant. */
    async function folderWorld() {
      const world = await setup();
      const legacy = createInMemoryObjectStoreProvider();
      const objects = createInMemoryObjectStore();
      const storage = createStorageService({
        catalog: (workspaceId) => world.catalogs.forWorkspace(workspaceId),
        objects,
        log: noLog,
      });
      const catalog = await world.catalogs.forWorkspace(world.a.workspaceId);
      const folder = await seedCatalogFile(catalog, {
        path: 'docs',
        kind: 'folder',
        sizeBytes: 0,
        contentType: null,
        ownerPrincipalId: world.a.principalId,
        createdBy: world.a.userId,
      });
      const loader = createAgentRunResourceLoader({
        catalog: world.catalogs,
        storage,
      });
      const loadFolder = async () => {
        const loaded = await loader.load(world.a.workspaceId, {
          files: [{ fileId: folder.id, access: 'read' }],
          skillIds: [],
          connectorIds: [],
          storageGrants: [],
        });
        return Promise.all(
          loaded.files.map(async (file) => [file.path, await sourceText(loaded, file.path)]),
        );
      };
      return { world, legacy, objects, storage, catalog, loadFolder };
    }

    // @story US-STO-05
    it('[US-STO-05][api][sdk] a folder grant delivers a child saved under the new naming', async () => {
      const { world, storage, loadFolder } = await folderWorld();
      const saved = await storage.save(ctxOf(world.a), {
        area: 'files',
        path: 'docs/new.txt',
        maxBytes: 1024,
        replace: true,
        body: bytesToStream(bytesOf('new naming')),
      });
      if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
      expect(saved.row.objectId).not.toBeNull();

      expect(await loadFolder()).toEqual([
        ['docs', null],
        ['docs/new.txt', 'new naming'],
      ]);
    });

    // @story US-STO-05
    it('[US-STO-05][api][sdk] a folder grant does not deliver a pending new-naming child', async () => {
      const { world, objects, catalog, loadFolder } = await folderWorld();
      const objectId = newObjectId();
      await catalog.reserve('docs/pending.txt', {
        area: 'files',
        objectId,
        ownerPrincipalId: world.a.principalId,
        createdBy: world.a.userId,
        sizeBytes: 0,
        contentType: 'text/plain',
      });
      await objects.write(
        storageObjectName(world.a.workspaceId, 'files', objectId),
        bytesOf('unverified'),
        {},
      );

      expect(await loadFolder()).toEqual([['docs', null]]);
    });

    // @story US-STO-05
    it('[US-STO-05][api][sdk] a nested folder row under a folder grant is a directory entry', async () => {
      const { world, catalog, loadFolder } = await folderWorld();
      await seedCatalogFile(catalog, {
        path: 'docs/nested',
        kind: 'folder',
        sizeBytes: 0,
        contentType: null,
        ownerPrincipalId: world.a.principalId,
        createdBy: world.a.userId,
      });

      expect(await loadFolder()).toEqual([
        ['docs', null],
        ['docs/nested', null],
      ]);
    });

    /** A catalog service over `world`, a skill catalog row `demo`, and a loader that delivers it. */
    async function skillWorld() {
      const world = await setup();
      const skills = createInMemoryObjectStoreProvider();
      const storage = createStorageService({
        catalog: (workspaceId) => world.catalogs.forWorkspace(workspaceId),
        objects: createInMemoryObjectStore(),
        log: noLog,
      });
      const catalog = await world.catalogs.forWorkspace(world.a.workspaceId);
      const skill = await catalog.putSkill({
        name: 'demo',
        skillMd: '# demo',
        enabled: true,
        ownerPrincipalId: world.a.principalId,
        createdBy: world.a.userId,
      });
      const saveRow = async (path: string, text: string) => {
        const saved = await storage.save(ctxOf(world.a), {
          area: 'skills',
          path,
          maxBytes: 1024,
          replace: true,
          body: bytesToStream(bytesOf(text)),
        });
        if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
      };
      const loader = createAgentRunResourceLoader({
        catalog: world.catalogs,
        skills,
        storage,
      });
      const loadFiles = async (skillRevisions?: Record<string, number>) => {
        const loaded = await loader.load(world.a.workspaceId, {
          files: [],
          skillIds: [skill.id],
          connectorIds: [],
          storageGrants: [],
          ...(skillRevisions === undefined ? {} : { skillRevisions }),
        });
        return Object.fromEntries(
          await Promise.all(
            (loaded.skills[0]?.files ?? []).map(async (file): Promise<[string, string | null]> => [
              file.path,
              await sourceText(loaded, skillInboxPath('demo', file.path)),
            ]),
          ),
        );
      };
      return { world, skills, skill, storage, saveRow, loadFiles, loader };
    }

    // @story US-STO-08
    it('[US-STO-08][api][sdk] a skill stored as catalog rows is delivered to a run', async () => {
      const { saveRow, loadFiles } = await skillWorld();
      await saveRow('.skills/demo/SKILL.md', '# demo from rows');
      await saveRow('.skills/demo/scripts/run.sh', 'echo rows');
      await saveRow('.skills/demo-two/SKILL.md', '# another skill');

      expect(await loadFiles()).toEqual({
        'SKILL.md': '# demo from rows',
        'scripts/run.sh': 'echo rows',
      });
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] a pinned revision stored as rows is delivered, not the current files', async () => {
      const { skill, saveRow, loadFiles } = await skillWorld();
      await saveRow('.skills/demo/SKILL.md', '# current');
      await saveRow('.skills/demo@1/SKILL.md', '# revision one');
      await saveRow('.skills/demo@1/notes.md', 'frozen');
      await saveRow('.skills/demo@2/SKILL.md', '# revision two');

      expect(await loadFiles({ [skill.id]: 1 })).toEqual({
        'SKILL.md': '# revision one',
        'notes.md': 'frozen',
      });
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] a skill row granted directly by id is not delivered as a run file', async () => {
      const { world, saveRow, loader } = await skillWorld();
      await saveRow('.skills/demo/SKILL.md', '# demo from rows');
      const catalog = await world.catalogs.forWorkspace(world.a.workspaceId);
      const skillRow = (await listCatalogFiles(catalog)).find(
        (file) => file.path === '.skills/demo/SKILL.md',
      );
      if (skillRow === undefined) throw new Error('the skill row was not saved');

      await expect(
        loader.load(world.a.workspaceId, {
          files: [{ fileId: skillRow.id, access: 'read' }],
          skillIds: [],
          connectorIds: [],
          storageGrants: [],
        }),
      ).rejects.toThrow('disappeared before the run was composed');
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] a legacy skill (prefix only, no rows) is still delivered to a run', async () => {
      const { world, skills, saveRow, loadFiles } = await skillWorld();
      const store = skills.forWorkspace(world.a.workspaceId);
      await store.write('skills/demo/SKILL.md', Buffer.from('# legacy'), {});
      await store.write('skills/demo/scripts/run.sh', Buffer.from('echo legacy'), {});

      expect(await loadFiles()).toEqual({
        'SKILL.md': '# legacy',
        'scripts/run.sh': 'echo legacy',
      });

      // The rows win once they exist: a leftover prefix is never merged into them.
      await saveRow('.skills/demo/SKILL.md', '# from rows');
      expect(await loadFiles()).toEqual({ 'SKILL.md': '# from rows' });
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] a patched legacy skill is migrated to rows and the run receives the patch', async () => {
      const { world, skills, storage, loadFiles } = await skillWorld();
      const store = skills.forWorkspace(world.a.workspaceId);
      await seedBareSkill(store, {
        name: 'demo',
        files: [
          { path: 'SKILL.md', contentBase64: Buffer.from('# legacy').toString('base64') },
          { path: 'scripts/run.sh', contentBase64: Buffer.from('echo legacy').toString('base64') },
        ],
      });
      const catalog = await world.catalogs.forWorkspace(world.a.workspaceId);

      const patched = await patchSkillWithId(
        store,
        catalog,
        { ownerPrincipalId: world.a.principalId, userId: world.a.userId },
        'demo',
        {
          files: [skillPayloadFile('SKILL.md', '# patched')],
        },
        { storage, workspaceId: world.a.workspaceId },
      );

      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      expect(await loadFiles()).toEqual({
        'SKILL.md': '# patched',
        'scripts/run.sh': 'echo legacy',
      });
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] a folder grant never delivers a skill row', async () => {
      const { world, loader, saveRow } = await skillWorld();
      await saveRow('.skills/demo/SKILL.md', '# demo');
      const catalog = await world.catalogs.forWorkspace(world.a.workspaceId);
      const folder = (await listCatalogFiles(catalog)).find((row) => row.path === '.skills');
      if (folder === undefined) throw new Error('saving a skill row created no folder row');

      const loaded = await loader.load(world.a.workspaceId, {
        files: [{ fileId: folder.id, access: 'read' }],
        skillIds: [],
        connectorIds: [],
        storageGrants: [],
      });
      expect(loaded.files.filter((file) => file.kind === 'file')).toEqual([]);
    });
  });
}

defineCatalogSuite('in-memory catalog', memoryWorld);
defineCatalogSuite('PostgreSQL catalog', postgresWorld);
