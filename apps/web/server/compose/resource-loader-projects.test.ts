import type { AgentPermissions } from '@agent-workspace/run-protocol';
import { describe, expect, it } from 'vitest';
import type { ConnectorsStoreProvider } from '../connectors/store';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { createAgentRunResourceLoader } from './resource-loader';
import {
  OWNER_PRINCIPAL,
  seededId,
  seedFiles,
  sha256Of,
  storageOver,
  WORKSPACE,
} from './resource-loader.test-support';

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
