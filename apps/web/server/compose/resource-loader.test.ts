import type { AgentPermissions } from '@agent-workspace/core';
import { createInMemoryObjectStoreProvider } from '@agent-workspace/core/storage';
import type { AgentResourceAssignments } from '@indx-workspace/contracts/agents';
import { OpenApiToolConfigSchema } from '@indx-workspace/contracts/tool-connectors';
import { describe, expect, it } from 'vitest';

import type {
  AnyConnectorResource,
  ConnectorResource,
  ToolConnectorResource,
} from '../connectors/contract';
import type { ConnectorsStoreProvider } from '../connectors/store';
import { createAgentRunResourceLoader } from './resource-loader';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const OWNER_PRINCIPAL = '44444444-4444-4444-8444-444444444444';

describe('agent run resource loader', () => {
  it('loads only assigned files and enabled skills, and refuses an assigned disabled connector', async () => {
    const assignedConnectorIds = ['connector-enabled'];
    const fileObjects = createInMemoryObjectStoreProvider();
    const skillObjects = createInMemoryObjectStoreProvider();
    await fileObjects.forWorkspace(WORKSPACE).put('assigned.txt', {
      body: Buffer.from('assigned'),
    });
    await fileObjects.forWorkspace(WORKSPACE).put('unassigned.txt', {
      body: Buffer.from('unassigned'),
    });
    await skillObjects.forWorkspace(WORKSPACE).put('skills/enabled/SKILL.md', {
      body: Buffer.from('# enabled'),
    });
    await skillObjects.forWorkspace(WORKSPACE).put('skills/disabled/SKILL.md', {
      body: Buffer.from('# disabled'),
    });
    await skillObjects.forWorkspace(WORKSPACE).put('skills/unassigned/SKILL.md', {
      body: Buffer.from('# unassigned'),
    });

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
      files: [{ fileId: 'file-assigned', access: 'read' }],
      skillIds: ['skill-enabled', 'skill-disabled'],
      connectorIds: [...assignedConnectorIds],
    });
    const loader = createAgentRunResourceLoader({
      catalog: {
        forWorkspace: () =>
          Promise.resolve({
            listFiles: () =>
              Promise.resolve([
                {
                  id: 'file-assigned',
                  path: 'assigned.txt',
                  kind: 'file',
                  storageKey: 'assigned.txt',
                  sizeBytes: 8,
                  contentType: 'text/plain',
                  ownerPrincipalId: OWNER_PRINCIPAL,
                  createdBy: 'test-owner',
                },
                {
                  id: 'file-unassigned',
                  path: 'unassigned.txt',
                  kind: 'file',
                  storageKey: 'unassigned.txt',
                  sizeBytes: 10,
                  contentType: 'text/plain',
                  ownerPrincipalId: OWNER_PRINCIPAL,
                  createdBy: 'test-owner',
                },
              ]),
            putFile: () => Promise.reject(new Error('unused')),
            renameFile: () => Promise.reject(new Error('unused')),
            deleteFile: () => Promise.reject(new Error('unused')),
            listSkills: () =>
              Promise.resolve([
                {
                  id: 'skill-enabled',
                  name: 'enabled',
                  skillMd: '# enabled',
                  enabled: true,
                  ownerPrincipalId: OWNER_PRINCIPAL,
                  createdBy: 'test-owner',
                },
                {
                  id: 'skill-disabled',
                  name: 'disabled',
                  skillMd: '# disabled',
                  enabled: false,
                  ownerPrincipalId: OWNER_PRINCIPAL,
                  createdBy: 'test-owner',
                },
                {
                  id: 'skill-unassigned',
                  name: 'unassigned',
                  skillMd: '# unassigned',
                  enabled: true,
                  ownerPrincipalId: OWNER_PRINCIPAL,
                  createdBy: 'test-owner',
                },
              ]),
            putSkill: () => Promise.reject(new Error('unused')),
            deleteSkill: () => Promise.reject(new Error('unused')),
          }),
      },
      files: fileObjects,
      skills: skillObjects,
      connectors,
    });

    const loaded = await loader.load(WORKSPACE, assigned());
    expect(loaded.files).toEqual([
      {
        kind: 'file',
        path: 'assigned.txt',
        access: 'read',
        contentBase64: Buffer.from('assigned').toString('base64'),
      },
    ]);
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
    const objects = createInMemoryObjectStoreProvider();
    const store = objects.forWorkspace(WORKSPACE);
    await store.put('root/loose.txt', { body: Buffer.from('loose') });
    await store.put('root/restricted/a.txt', { body: Buffer.from('a') });
    await store.put('root/restricted/deeper/exception.txt', { body: Buffer.from('exception') });
    const assigned = (): AgentResourceAssignments => ({
      files: [
        { fileId: 'root', access: 'read-write' },
        { fileId: 'restricted', access: 'read' },
        { fileId: 'exception', access: 'read-write' },
      ],
      skillIds: [],
      connectorIds: [],
    });
    const loader = createAgentRunResourceLoader({
      catalog: {
        forWorkspace: () =>
          Promise.resolve({
            listFiles: () =>
              Promise.resolve([
                {
                  id: 'root',
                  path: 'root',
                  kind: 'folder',
                  storageKey: 'root',
                  sizeBytes: 0,
                  contentType: null,
                  ownerPrincipalId: OWNER_PRINCIPAL,
                  createdBy: 'test-owner',
                },
                {
                  id: 'restricted',
                  path: 'root/restricted',
                  kind: 'folder',
                  storageKey: 'root/restricted',
                  sizeBytes: 0,
                  contentType: null,
                  ownerPrincipalId: OWNER_PRINCIPAL,
                  createdBy: 'test-owner',
                },
                {
                  id: 'exception',
                  path: 'root/restricted/deeper/exception.txt',
                  kind: 'file',
                  storageKey: 'root/restricted/deeper/exception.txt',
                  sizeBytes: 9,
                  contentType: 'text/plain',
                  ownerPrincipalId: OWNER_PRINCIPAL,
                  createdBy: 'test-owner',
                },
              ]),
            putFile: () => Promise.reject(new Error('unused')),
            renameFile: () => Promise.reject(new Error('unused')),
            deleteFile: () => Promise.reject(new Error('unused')),
            listSkills: () => Promise.resolve([]),
            putSkill: () => Promise.reject(new Error('unused')),
            deleteSkill: () => Promise.reject(new Error('unused')),
          }),
      },
      files: objects,
    });

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

  it('rejects mixed-case aliases of the runner private directory from legacy catalogs', async () => {
    const objects = createInMemoryObjectStoreProvider();
    await objects.forWorkspace(WORKSPACE).put('.ClAuDe/settings.json', { body: Buffer.from('{}') });
    const assigned = (): AgentResourceAssignments => ({
      files: [{ fileId: 'private', access: 'read-write' }],
      skillIds: [],
      connectorIds: [],
    });
    const loader = createAgentRunResourceLoader({
      catalog: {
        forWorkspace: () =>
          Promise.resolve({
            listFiles: () =>
              Promise.resolve([
                {
                  id: 'private',
                  path: '.ClAuDe/settings.json',
                  kind: 'file',
                  storageKey: '.ClAuDe/settings.json',
                  sizeBytes: 2,
                  contentType: 'application/json',
                  ownerPrincipalId: OWNER_PRINCIPAL,
                  createdBy: 'test-owner',
                },
              ]),
            putFile: () => Promise.reject(new Error('unused')),
            renameFile: () => Promise.reject(new Error('unused')),
            deleteFile: () => Promise.reject(new Error('unused')),
            listSkills: () => Promise.resolve([]),
            putSkill: () => Promise.reject(new Error('unused')),
            deleteSkill: () => Promise.reject(new Error('unused')),
          }),
      },
      files: objects,
    });

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
  function fixture(agentFiles: readonly { fileId: string; access: 'read' | 'read-write' }[]) {
    const objects = createInMemoryObjectStoreProvider();
    const store = objects.forWorkspace(WORKSPACE);
    return {
      objects,
      store,
      assignments: { files: agentFiles, skillIds: [], connectorIds: [] },
      catalog: {
        forWorkspace: () =>
          Promise.resolve({
            listFiles: () =>
              Promise.resolve([
                {
                  id: 'project-folder',
                  path: 'shared',
                  kind: 'folder' as const,
                  storageKey: 'shared',
                  sizeBytes: 0,
                  contentType: null,
                  ownerPrincipalId: OWNER_PRINCIPAL,
                  createdBy: 'test-owner',
                },
                {
                  id: 'agent-file',
                  path: 'shared/mine.txt',
                  kind: 'file' as const,
                  storageKey: 'shared/mine.txt',
                  sizeBytes: 3,
                  contentType: 'text/plain',
                  ownerPrincipalId: OWNER_PRINCIPAL,
                  createdBy: 'test-owner',
                },
              ]),
            putFile: () => Promise.reject(new Error('unused')),
            renameFile: () => Promise.reject(new Error('unused')),
            deleteFile: () => Promise.reject(new Error('unused')),
            listSkills: () => Promise.resolve([]),
            putSkill: () => Promise.reject(new Error('unused')),
            deleteSkill: () => Promise.reject(new Error('unused')),
          }),
      },
    };
  }

  it('composes a project folder association into the run when the agent has read-file permission', async () => {
    const { objects, store, assignments, catalog } = fixture([]);
    await store.put('shared/other.txt', { body: Buffer.from('other') });
    const loader = createAgentRunResourceLoader({
      catalog,
      files: objects,
      projectResources: {
        listFileIds: () => Promise.resolve(['project-folder']),
        listMcpServerIds: () => Promise.resolve([]),
      },
    });

    const loaded = await loader.load(WORKSPACE, assignments, PROJECT, ALL_ON);
    expect(loaded.files.map(({ path, access }) => [path, access])).toEqual([
      ['shared', 'read'],
      ['shared/other.txt', 'read'],
    ]);
  });

  it("refuses — rather than silently dropping — a project folder the agent's own readFiles permission does not reach", async () => {
    const { objects, assignments, catalog } = fixture([]);
    const loader = createAgentRunResourceLoader({
      catalog,
      files: objects,
      projectResources: {
        listFileIds: () => Promise.resolve(['project-folder']),
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
    const { objects, store, assignments, catalog } = fixture([
      { fileId: 'agent-file', access: 'read-write' },
    ]);
    await store.put('shared/mine.txt', { body: Buffer.from('abc') });
    const loader = createAgentRunResourceLoader({
      catalog,
      files: objects,
      // The project also associates the exact same file the agent already has read-write on.
      projectResources: {
        listFileIds: () => Promise.resolve(['agent-file']),
        listMcpServerIds: () => Promise.resolve([]),
      },
    });

    const loaded = await loader.load(WORKSPACE, assignments, PROJECT, ALL_ON);
    expect(loaded.files).toEqual([
      {
        kind: 'file',
        path: 'shared/mine.txt',
        access: 'read-write',
        contentBase64: Buffer.from('abc').toString('base64'),
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
    const { assignments, catalog } = fixture([]);
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
    const { assignments, catalog } = fixture([]);
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
    const { objects, assignments, catalog } = fixture([]);
    const loader = createAgentRunResourceLoader({
      catalog,
      files: objects,
      projectResources: {
        listFileIds: () => Promise.reject(new Error('must not be called without a project id')),
        listMcpServerIds: () =>
          Promise.reject(new Error('must not be called without a project id')),
      },
    });

    await expect(loader.load(WORKSPACE, assignments)).resolves.toEqual({
      files: [],
      skills: [],
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
    const assignments = { files: [], skillIds: [], connectorIds: [...connectorIds] };
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
