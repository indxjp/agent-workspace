import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { files } from '../schema/files.js';
import { seedCatalogFile } from './catalog-fixtures.js';
import {
  isolated,
  principalA,
  scopeA,
  scopeB,
  userA,
} from './resource-catalogs.fixture.test-support.js';
import {
  createDatabaseResourceCatalogRepositoryProvider,
  listCatalogFiles,
} from './resource-catalogs.js';

export function describeCatalogParentTests(): void {
  describe('a catalog write adds the parent folders of a file or folder (issue #899)', () => {
    const fileInput = (path: string, owner: string, user: string) => ({
      path,
      kind: 'file' as const,
      storageKey: path,
      sizeBytes: 1,
      contentType: null,
      ownerPrincipalId: owner,
      createdBy: user,
    });

    it('creates one folder row per parent, so a files() grant on the folder resolves', async () => {
      const repo = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      await seedCatalogFile(repo, fileInput('manuals/hydraulics/unit.md', principalA, userA));

      const rows = await listCatalogFiles(repo);
      for (const path of ['manuals', 'manuals/hydraulics']) {
        expect(rows.find((row) => row.path === path)).toMatchObject({
          kind: 'folder',
          storageKey: null,
          sizeBytes: 0,
          contentType: null,
          ownerPrincipalId: principalA,
          createdBy: userA,
        });
      }
    });

    it('creates the parent rows of a nested folder too', async () => {
      const repo = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      await seedCatalogFile(repo, {
        path: 'contracts/2026',
        kind: 'folder',
        sizeBytes: 0,
        contentType: null,
        ownerPrincipalId: principalA,
        createdBy: userA,
      });

      expect((await listCatalogFiles(repo)).find((row) => row.path === 'contracts')).toMatchObject({
        kind: 'folder',
        ownerPrincipalId: principalA,
      });
    });

    it('keeps the id and owner of an existing folder row and never replaces a file row', async () => {
      const repo = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      const folder = await seedCatalogFile(repo, {
        path: 'kept',
        kind: 'folder',
        sizeBytes: 0,
        contentType: null,
        ownerPrincipalId: principalA,
        createdBy: null,
      });
      const file = await seedCatalogFile(repo, fileInput('shadowed', principalA, userA));
      await seedCatalogFile(repo, fileInput('kept/a.md', principalA, userA));
      await seedCatalogFile(repo, fileInput('shadowed/b.md', principalA, userA));

      const rows = await listCatalogFiles(repo);
      expect(rows.find((row) => row.path === 'kept')).toMatchObject({
        id: folder.id,
        createdBy: null,
      });
      expect(rows.find((row) => row.path === 'shadowed')).toMatchObject({
        id: file.id,
        kind: 'file',
      });
    });

    it('writes the parent rows into the uploading workspace only', async () => {
      const a = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      const b = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeB);
      await seedCatalogFile(a, fileInput('only-in-a/x.md', principalA, userA));

      expect((await listCatalogFiles(a)).map((row) => row.path)).toContain('only-in-a');
      expect((await listCatalogFiles(b)).map((row) => row.path)).not.toContain('only-in-a');
    });

    it('renameFile writes the parent folders of the target path, in its workspace only', async () => {
      const a = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      const b = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeB);
      const file = await seedCatalogFile(a, fileInput('rename-source.md', principalA, userA));

      await a.rename(file.path, 'rename-target/deep/moved.md');

      const rows = await listCatalogFiles(a);
      for (const path of ['rename-target', 'rename-target/deep']) {
        expect(rows.find((row) => row.path === path)).toMatchObject({
          kind: 'folder',
          ownerPrincipalId: principalA,
          createdBy: userA,
        });
      }
      expect(rows.find((row) => row.id === file.id)).toMatchObject({
        path: 'rename-target/deep/moved.md',
      });
      expect((await listCatalogFiles(b)).map((row) => row.path)).not.toContain('rename-target');
    });

    it('a folder rename writes the target folder and its parents when only children moved', async () => {
      const a = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      const b = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeB);
      // Drop the parent row the write added, the shape a pre-0051 upload left behind, so only the
      // child moves.
      const seeded = await seedCatalogFile(a, fileInput('prefix-source/x.md', principalA, userA));
      await isolated.db
        .delete(files)
        .where(and(eq(files.workspaceId, scopeA.workspaceId), eq(files.path, 'prefix-source')));

      await expect(a.rename('prefix-source', 'prefix-target/inner')).resolves.toEqual({
        rows: 1,
        files: 1,
      });

      const rows = await listCatalogFiles(a);
      for (const path of ['prefix-target', 'prefix-target/inner']) {
        expect(rows.find((row) => row.path === path)).toMatchObject({
          kind: 'folder',
          ownerPrincipalId: principalA,
        });
      }
      expect(rows.find((row) => row.id === seeded.id)).toMatchObject({
        path: 'prefix-target/inner/x.md',
      });
      expect((await listCatalogFiles(b)).map((row) => row.path)).not.toContain('prefix-target');
    });
  });
}
