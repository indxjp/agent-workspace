import { seedCatalogFile } from '@agent-workspace/core/db';
import {
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
  newObjectId,
  storageObjectName,
} from '@agent-workspace/core/storage';
import type { AgentResourceAssignments } from '@indx-workspace/contracts/agents';
import { describe, expect, it } from 'vitest';
import type { ConnectorsStoreProvider } from '../connectors/store';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { createStorageService } from '../storage/service';
import { createAgentRunResourceLoader } from './resource-loader';
import {
  noLog,
  OWNER_PRINCIPAL,
  seededId,
  seedFiles,
  sha256Of,
  sourceText,
  storageOver,
  WORKSPACE,
} from './resource-loader.test-support';

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
