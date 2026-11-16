import { and, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { agentFiles } from '../schema/agent-files.js';
import { agents } from '../schema/agents.js';
import { files } from '../schema/files.js';
import { seedCatalogFile } from './catalog-fixtures.js';
import {
  isolated,
  principalA,
  principalB,
  scopeA,
  scopeB,
  userA,
  userB,
} from './resource-catalogs.fixture.test-support.js';
import {
  createDatabaseResourceCatalogRepositoryProvider,
  listCatalogFiles,
} from './resource-catalogs.js';

export function describeCatalogFolderTests(): void {
  describe('folder rename and remove (W9-FILES-131)', () => {
    it('rewrites a folder and every descendant path while keeping ids and object keys, and leaves a same-prefixed sibling alone', async () => {
      const repo = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      const folder = await seedCatalogFile(repo, {
        path: 'a',
        kind: 'folder',
        sizeBytes: 0,
        contentType: null,
        ownerPrincipalId: principalA,
        createdBy: userA,
      });
      const child = await seedCatalogFile(repo, {
        path: 'a/b/c.txt',
        kind: 'file',
        sizeBytes: 3,
        contentType: 'text/plain',
        ownerPrincipalId: principalA,
        createdBy: userA,
      });
      // The prefix-boundary counter-example: `a-sibling.txt` starts with the same three
      // characters as `a` but is not a descendant of it, and must survive untouched.
      const sibling = await seedCatalogFile(repo, {
        path: 'a-sibling.txt',
        kind: 'file',
        sizeBytes: 1,
        contentType: null,
        ownerPrincipalId: principalA,
        createdBy: userA,
      });

      // `a`, `a/b` (the folder row the write of `a/b/c.txt` added for its parent) and the file.
      await expect(repo.rename('a', 'z')).resolves.toEqual({ rows: 3, files: 1 });

      const rows = await listCatalogFiles(repo);
      const renamedFolder = rows.find((row) => row.id === folder.id);
      const renamedChild = rows.find((row) => row.id === child.id);
      const untouchedSibling = rows.find((row) => row.id === sibling.id);
      expect(renamedFolder).toMatchObject({ id: folder.id, path: 'z', storageKey: null });
      expect(renamedChild).toMatchObject({
        id: child.id,
        path: 'z/b/c.txt',
        storageKey: child.storageKey,
      });
      expect(untouchedSibling).toMatchObject({ id: sibling.id, path: 'a-sibling.txt' });
    });

    it('preserves the file id an agent_files grant references across a subtree rename (issue #131)', async () => {
      const repo = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      const file = await seedCatalogFile(repo, {
        path: 'assigned/note.txt',
        kind: 'file',
        sizeBytes: 4,
        contentType: 'text/plain',
        ownerPrincipalId: principalA,
        createdBy: userA,
      });
      const agentId = crypto.randomUUID();
      const agentWorkspace = await isolated.db
        .select({ workspaceId: files.workspaceId })
        .from(files)
        .where(eq(files.id, file.id));
      const workspaceId = agentWorkspace[0]!.workspaceId;
      await isolated.db.insert(agents).values({
        id: agentId,
        workspaceId,
        name: 'Assignee',
        instructions: '',
        modelConnectionId: null,
        model: null,
        permissions: {
          readFiles: true,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
        ownerPrincipalId: principalA,
        createdBy: userA,
      });
      await isolated.db.insert(agentFiles).values({
        workspaceId,
        agentId,
        fileId: file.id,
        access: 'read',
      });

      await repo.rename('assigned', 'moved');

      const grant = await isolated.db
        .select({ fileId: agentFiles.fileId })
        .from(agentFiles)
        .where(and(eq(agentFiles.workspaceId, workspaceId), eq(agentFiles.agentId, agentId)));
      expect(grant).toEqual([{ fileId: file.id }]);
      const rows = await listCatalogFiles(repo);
      expect(rows.find((row) => row.id === file.id)).toMatchObject({ path: 'moved/note.txt' });
    });

    it('does not touch another workspace, and is a no-op when nothing is under the prefix', async () => {
      const a = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      const b = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeB);
      const otherWorkspaceFile = await seedCatalogFile(b, {
        path: 'shared-prefix/x.txt',
        kind: 'file',
        sizeBytes: 1,
        contentType: null,
        ownerPrincipalId: principalB,
        createdBy: userB,
      });

      await expect(a.rename('shared-prefix', 'renamed-prefix')).resolves.toEqual({
        rows: 0,
        files: 0,
      });
      const stillThere = await listCatalogFiles(b);
      expect(stillThere.find((row) => row.id === otherWorkspaceFile.id)).toMatchObject({
        path: 'shared-prefix/x.txt',
      });

      await expect(a.remove('does-not-exist')).resolves.toEqual([]);
    });

    it('removing a folder takes its descendants, never a same-prefixed sibling', async () => {
      const repo = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      const folder = await seedCatalogFile(repo, {
        path: 'to-delete',
        kind: 'folder',
        sizeBytes: 0,
        contentType: null,
        ownerPrincipalId: principalA,
        createdBy: userA,
      });
      const child = await seedCatalogFile(repo, {
        path: 'to-delete/child.txt',
        kind: 'file',
        sizeBytes: 1,
        contentType: null,
        ownerPrincipalId: principalA,
        createdBy: userA,
      });
      const sibling = await seedCatalogFile(repo, {
        path: 'to-delete-sibling.txt',
        kind: 'file',
        sizeBytes: 1,
        contentType: null,
        ownerPrincipalId: principalA,
        createdBy: userA,
      });

      await repo.remove('to-delete');

      const rows = await listCatalogFiles(repo);
      expect(rows.find((row) => row.id === folder.id)).toBeUndefined();
      expect(rows.find((row) => row.id === child.id)).toBeUndefined();
      expect(rows.find((row) => row.id === sibling.id)).toMatchObject({
        path: 'to-delete-sibling.txt',
      });
    });

    it('rewrites and deletes a subtree whose prefix contains a character outside the BMP (W9-FILES-131 round 2)', async () => {
      // U+1F600 is ONE Postgres character but TWO UTF-16 code units, so `prefix.length` in JS
      // (4, for the emoji plus "x") overshoots `char_length(prefix)` in Postgres (3). Before the
      // round-2 fix this mismatch made `pathUnderPrefix` and `renameFilesByPrefix`'s cut point
      // miss every row under the prefix entirely — see the sibling site-enumeration note above
      // `pathUnderPrefix` in resource-catalogs.ts.
      const repo = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      const prefix = '😀x';
      const folder = await seedCatalogFile(repo, {
        path: prefix,
        kind: 'folder',
        sizeBytes: 0,
        contentType: null,
        ownerPrincipalId: principalA,
        createdBy: userA,
      });
      const child = await seedCatalogFile(repo, {
        path: `${prefix}/inner.txt`,
        kind: 'file',
        sizeBytes: 1,
        contentType: 'text/plain',
        ownerPrincipalId: principalA,
        createdBy: userA,
      });
      const sibling = await seedCatalogFile(repo, {
        path: `${prefix}-sibling.txt`,
        kind: 'file',
        sizeBytes: 1,
        contentType: null,
        ownerPrincipalId: principalA,
        createdBy: userA,
      });

      await expect(repo.rename(prefix, 'moved-emoji')).resolves.toEqual({ rows: 2, files: 1 });

      const rowsAfterRename = await listCatalogFiles(repo);
      expect(rowsAfterRename.find((row) => row.id === folder.id)).toMatchObject({
        path: 'moved-emoji',
        storageKey: null,
      });
      expect(rowsAfterRename.find((row) => row.id === child.id)).toMatchObject({
        path: 'moved-emoji/inner.txt',
        storageKey: child.storageKey,
      });
      expect(rowsAfterRename.find((row) => row.id === sibling.id)).toMatchObject({
        path: `${prefix}-sibling.txt`,
      });

      await repo.remove('moved-emoji');

      const rowsAfterDelete = await listCatalogFiles(repo);
      expect(rowsAfterDelete.find((row) => row.id === folder.id)).toBeUndefined();
      expect(rowsAfterDelete.find((row) => row.id === child.id)).toBeUndefined();
      expect(rowsAfterDelete.find((row) => row.id === sibling.id)).toMatchObject({
        path: `${prefix}-sibling.txt`,
      });
    });
  });
}
