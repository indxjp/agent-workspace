import { createInMemoryObjectStore } from '@agent-workspace/core/storage';
import { bytesToStream, encodeUstar } from '@agent-workspace/runtime/transfer';
import { describe, expect, it } from 'vitest';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import type { LaunchContext } from '../runs/environment';
import { createStorageService } from '../storage/service';
import { createAgentRunResourceLoader } from './resource-loader';
import { createRuntimeWorkspaceLifecycle } from './workspace-lifecycle';
import { context, members, quietLog, target } from './workspace-lifecycle.test-support';

describe('run delivery through the catalog service', () => {
  const owner = {
    workspaceId: '22222222-2222-4222-8222-222222222222',
    principalId: 'owner-1',
    userId: 'user-1',
  };
  const launch = {
    ...context,
    principal: {
      ...context.principal,
      workspaceId: owner.workspaceId,
      ownerPrincipalId: 'owner-1',
    },
  } as LaunchContext;

  // @story US-STO-06
  // Before the change a run without `storage` fell back to path reads, so no catalog row was needed.
  it('[US-STO-06][api][run] a granted file reaches the run and its promoted output lands as an artifacts row', async () => {
    const catalogs = createInMemoryCatalogStore();
    const storage = createStorageService({
      catalog: (workspaceId) => catalogs.forWorkspace(workspaceId),
      objects: createInMemoryObjectStore(),
      log: quietLog,
    });
    const saved = await storage.save(owner, {
      area: 'files',
      path: 'notes/input.txt',
      body: bytesToStream(Buffer.from('hello')),
      maxBytes: 1024,
      replace: false,
    });
    if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
    const loader = createAgentRunResourceLoader({ catalog: catalogs, storage });
    const lifecycle = createRuntimeWorkspaceLifecycle({
      storage,
      granted: () =>
        loader.load(owner.workspaceId, {
          files: [{ fileId: saved.row.id, access: 'read' }],
          skillIds: [],
          connectorIds: [],
        }),
      resources: { load: () => Promise.resolve({ files: [], skills: [], mcpServers: {} }) },
    });

    expect(await members(await lifecycle.inputArchive(launch))).toMatchObject([
      {
        path: `${owner.workspaceId}/session-1/notes/input.txt`,
        type: 'file',
        mode: 0o444,
        data: Buffer.from('hello'),
      },
    ]);

    await lifecycle.promoteOutputs(
      launch,
      target,
      encodeUstar([
        { path: 'output', type: 'directory', mode: 0o755 },
        { path: 'output/result.txt', type: 'file', mode: 0o644, data: Buffer.from('done') },
      ]),
    );
    expect(await storage.get(owner, 'files', 'runs/run-1/outputs/output/result.txt')).toMatchObject(
      { area: 'artifacts', sizeBytes: 4 },
    );
  });

  // @story US-STO-06
  // Before the change a loader without `storage` read the granted file by path and never threw.
  it('[US-STO-06][unit][run] a run with assigned files and no catalog service fails loudly', async () => {
    const loader = createAgentRunResourceLoader({ catalog: createInMemoryCatalogStore() });
    await expect(
      loader.load(owner.workspaceId, {
        files: [{ fileId: 'file-1', access: 'read' }],
        skillIds: [],
        connectorIds: [],
      }),
    ).rejects.toThrow('this agent has assigned files, but file storage is not configured');
  });
});
