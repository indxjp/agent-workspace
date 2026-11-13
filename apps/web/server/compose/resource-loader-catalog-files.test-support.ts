import {
  bytesToStream,
  createInMemoryObjectStore,
  newObjectId,
} from '@agent-workspace/core/storage';
import { RUN_FILES_MAX_BYTES } from '@agent-workspace/runtime/transfer';
import { expect, it } from 'vitest';
import { createStorageService } from '../storage/service';
import { assertRunFilesFit, createAgentRunResourceLoader } from './resource-loader';
import {
  bytesOf,
  ctxOf,
  noLog,
  sha256Of,
  sourceText,
  type World,
} from './resource-loader.test-support';
export function defineCatalogFilesCases(setup: () => Promise<World>): void {
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
}
