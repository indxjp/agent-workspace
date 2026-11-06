import type { AgentPermissions } from '@agent-workspace/run-protocol';
import { OpenApiToolConfigSchema } from '@indx-workspace/contracts/tool-connectors';
import { describe, expect, it } from 'vitest';
import type {
  AnyConnectorResource,
  ConnectorResource,
  ToolConnectorResource,
} from '../connectors/contract';
import type { ConnectorsStoreProvider } from '../connectors/store';
import { createAgentRunResourceLoader } from './resource-loader';
import { OWNER_PRINCIPAL, WORKSPACE } from './resource-loader.test-support';

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
