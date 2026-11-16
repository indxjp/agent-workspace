import {
  bytesToStream,
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
} from '@agent-workspace/core/storage';
import { createStorageService } from '../storage/service';
import type { SkillRowsAccess } from './tree';
import { listCatalogFiles } from '@agent-workspace/core/db';
import { noLog, type Fixture, recording } from './markers.fixture.test-support';
export function createSkillMarkerFixture(setup: () => Promise<Fixture>) {
  async function world() {
    const { principal, catalog, assign, tryAssign } = await setup();
    const traced = recording(
      createInMemoryObjectStoreProvider().forWorkspace(principal.workspaceId),
    );
    const shared = traced.store;
    const storage = createStorageService({
      catalog: () => Promise.resolve(catalog),
      objects: createInMemoryObjectStore(),
      log: noLog,
    });
    const rows: SkillRowsAccess = { storage, workspaceId: principal.workspaceId };
    const ctx = { workspaceId: principal.workspaceId, principalId: principal.ownerPrincipalId };
    const saveRow = async (path: string, text: string) => {
      const saved = await storage.save(
        { ...ctx, userId: principal.userId },
        {
          area: 'skills',
          path,
          maxBytes: 1024,
          replace: true,
          body: bytesToStream(new TextEncoder().encode(text)),
        },
      );
      if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
    };
    const skillRowPaths = async (): Promise<string[]> =>
      (await listCatalogFiles(catalog))
        .filter((row) => row.kind === 'file' && row.path.startsWith('.skills/'))
        .map((row) => row.path)
        .sort();
    const putLegacy = (key: string, json: unknown) =>
      shared.write(key, new TextEncoder().encode(JSON.stringify(json)), {
        contentType: 'application/json',
      });
    return {
      principal,
      catalog,
      assign,
      tryAssign,
      shared,
      puts: traced.puts,
      storage,
      rows,
      saveRow,
      skillRowPaths,
      putLegacy,
    };
  }
  return {
    get world() {
      return world;
    },
  };
}
export type SkillMarkerFixture = ReturnType<typeof createSkillMarkerFixture>;
