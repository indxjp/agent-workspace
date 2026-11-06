import { seedCatalogFile } from '@agent-workspace/core/db';
import {
  bytesToStream,
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
  newObjectId,
  storageObjectName,
} from '@agent-workspace/core/storage';
import { expect, it } from 'vitest';
import { createStorageService } from '../storage/service';
import { createAgentRunResourceLoader } from './resource-loader';
import { bytesOf, ctxOf, noLog, sourceText, type World } from './resource-loader.test-support';
export function defineCatalogFoldersCases(setup: () => Promise<World>): void {
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
}
