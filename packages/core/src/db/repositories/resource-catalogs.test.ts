import crypto from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agentFiles } from '../schema/agent-files.js';
import { agentSkills } from '../schema/agent-skills.js';
import { agents } from '../schema/agents.js';
import { files } from '../schema/files.js';
import { memberships } from '../schema/memberships.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseResourceCatalogRepositoryProvider } from './resource-catalogs.js';
import { createDatabaseWorkspaceScopeResolver, type WorkspaceScope } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describe.skipIf(!hasDatabase)('ResourceCatalogRepository against PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  let scopeA: WorkspaceScope;
  let scopeB: WorkspaceScope;
  /** `created_by` is tenant-paired to `memberships` (issue #117); one owner per workspace. */
  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const membershipA = crypto.randomUUID();
  const membershipB = crypto.randomUUID();
  const principalA = crypto.randomUUID();
  const principalB = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_resource_catalogs');
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    await isolated.db.insert(workspaces).values([
      { id: ids[0]!, slug: 'catalog-a', name: 'A' },
      { id: ids[1]!, slug: 'catalog-b', name: 'B' },
    ]);
    await isolated.db.insert(users).values([
      { id: userA, email: `${userA}@example.test`, name: 'Owner A' },
      { id: userB, email: `${userB}@example.test`, name: 'Owner B' },
    ]);
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values([
        { id: membershipA, workspaceId: ids[0]!, userId: userA, role: 'owner' },
        { id: membershipB, workspaceId: ids[1]!, userId: userB, role: 'owner' },
      ]);
      await tx.insert(workspacePrincipals).values([
        {
          id: principalA,
          workspaceId: ids[0]!,
          kind: 'membership',
          membershipId: membershipA,
        },
        {
          id: principalB,
          workspaceId: ids[1]!,
          kind: 'membership',
          membershipId: membershipB,
        },
      ]);
    });
    const resolver = createDatabaseWorkspaceScopeResolver(isolated.db);
    const a = await resolver.forWorkspaceId(ids[0]!);
    const b = await resolver.forWorkspaceId(ids[1]!);
    if (a === null || b === null) throw new Error('catalog scopes did not resolve');
    scopeA = a;
    scopeB = b;
  }, 180_000);

  afterAll(async () => isolated.close());

  it('upserts stable file and skill ids within one workspace', async () => {
    const repo = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
    const file = await repo.putFile({
      path: 'handbook/readme.md',
      kind: 'file',
      storageKey: 'handbook/readme.md',
      sizeBytes: 12,
      contentType: 'text/markdown',
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    const updated = await repo.putFile({
      path: file.path,
      kind: 'file',
      storageKey: file.storageKey,
      sizeBytes: 13,
      contentType: file.contentType,
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    expect(updated.id).toBe(file.id);
    const renamed = await repo.renameFile(file.path, {
      path: 'handbook/renamed.md',
      kind: 'file',
      storageKey: 'handbook/renamed.md',
      sizeBytes: updated.sizeBytes,
      contentType: updated.contentType,
    });
    expect(renamed).toMatchObject({ id: file.id, path: 'handbook/renamed.md' });
    const skill = await repo.putSkill({
      name: 'reviewer',
      skillMd: '# Reviewer',
      enabled: true,
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    const skillUpdated = await repo.putSkill({
      name: skill.name,
      skillMd: '# Better',
      enabled: false,
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    expect(skillUpdated.id).toBe(skill.id);
  });

  it('keeps equal paths and names isolated by workspace', async () => {
    const a = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
    const b = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeB);
    const fileA = await a.putFile({
      path: 'same.txt',
      kind: 'file',
      storageKey: 'same.txt',
      sizeBytes: 1,
      contentType: null,
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    const fileB = await b.putFile({
      path: 'same.txt',
      kind: 'file',
      storageKey: 'same.txt',
      sizeBytes: 2,
      contentType: null,
      ownerPrincipalId: principalB,
      createdBy: userB,
    });
    expect(fileA.id).not.toBe(fileB.id);
    expect((await a.listFiles()).map((file) => file.id)).not.toContain(fileB.id);
  });

  describe('putFile writes the parent folders of a file or folder (issue #899)', () => {
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
      await repo.putFile(fileInput('manuals/hydraulics/unit.md', principalA, userA));

      const rows = await repo.listFiles();
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
      await repo.putFile({
        path: 'contracts/2026',
        kind: 'folder',
        storageKey: null,
        sizeBytes: 0,
        contentType: null,
        ownerPrincipalId: principalA,
        createdBy: userA,
      });

      expect((await repo.listFiles()).find((row) => row.path === 'contracts')).toMatchObject({
        kind: 'folder',
        ownerPrincipalId: principalA,
      });
    });

    it('keeps the id and owner of an existing folder row and never replaces a file row', async () => {
      const repo = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      const folder = await repo.putFile({
        path: 'kept',
        kind: 'folder',
        storageKey: null,
        sizeBytes: 0,
        contentType: null,
        ownerPrincipalId: principalA,
        createdBy: null,
      });
      const file = await repo.putFile(fileInput('shadowed', principalA, userA));
      await repo.putFile(fileInput('kept/a.md', principalA, userA));
      await repo.putFile(fileInput('shadowed/b.md', principalA, userA));

      const rows = await repo.listFiles();
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
      await a.putFile(fileInput('only-in-a/x.md', principalA, userA));

      expect((await a.listFiles()).map((row) => row.path)).toContain('only-in-a');
      expect((await b.listFiles()).map((row) => row.path)).not.toContain('only-in-a');
    });

    it('renameFile writes the parent folders of the target path, in its workspace only', async () => {
      const a = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      const b = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeB);
      const file = await a.putFile(fileInput('rename-source.md', principalA, userA));

      await a.renameFile(file.path, {
        path: 'rename-target/deep/moved.md',
        kind: 'file',
        storageKey: 'rename-target/deep/moved.md',
        sizeBytes: 1,
        contentType: null,
      });

      const rows = await a.listFiles();
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
      expect((await b.listFiles()).map((row) => row.path)).not.toContain('rename-target');
    });

    it('renameFilesByPrefix writes the target folder and its parents when only children moved', async () => {
      const a = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      const b = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeB);
      // Drop the parent row `putFile` wrote, the shape a pre-0051 upload left behind, so only the
      // child moves.
      const seeded = await a.putFile(fileInput('prefix-source/x.md', principalA, userA));
      await a.deleteFile('prefix-source');

      const renamed = await a.renameFilesByPrefix!('prefix-source', 'prefix-target/inner');
      expect(renamed.map((row) => row.path)).toEqual(['prefix-target/inner/x.md']);

      const rows = await a.listFiles();
      for (const path of ['prefix-target', 'prefix-target/inner']) {
        expect(rows.find((row) => row.path === path)).toMatchObject({
          kind: 'folder',
          ownerPrincipalId: principalA,
        });
      }
      expect(rows.find((row) => row.id === seeded.id)).toMatchObject({
        path: 'prefix-target/inner/x.md',
      });
      expect((await b.listFiles()).map((row) => row.path)).not.toContain('prefix-target');
    });
  });

  describe('renameFilesByPrefix / deleteFilesByPrefix (W9-FILES-131)', () => {
    it('rewrites a folder and every descendant path/storage key while keeping ids, and leaves a same-prefixed sibling alone', async () => {
      const repo = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      const folder = await repo.putFile({
        path: 'a',
        kind: 'folder',
        storageKey: null,
        sizeBytes: 0,
        contentType: null,
        ownerPrincipalId: principalA,
        createdBy: userA,
      });
      const child = await repo.putFile({
        path: 'a/b/c.txt',
        kind: 'file',
        storageKey: 'a/b/c.txt',
        sizeBytes: 3,
        contentType: 'text/plain',
        ownerPrincipalId: principalA,
        createdBy: userA,
      });
      // The prefix-boundary counter-example: `a-sibling.txt` starts with the same three
      // characters as `a` but is not a descendant of it, and must survive untouched.
      const sibling = await repo.putFile({
        path: 'a-sibling.txt',
        kind: 'file',
        storageKey: 'a-sibling.txt',
        sizeBytes: 1,
        contentType: null,
        ownerPrincipalId: principalA,
        createdBy: userA,
      });

      const renamed = await repo.renameFilesByPrefix!('a', 'z');
      // `a/b` is the folder row `putFile('a/b/c.txt')` wrote for the file's parent.
      expect(renamed.map((row) => row.path).sort()).toEqual(['z', 'z/b', 'z/b/c.txt']);

      const rows = await repo.listFiles();
      const renamedFolder = rows.find((row) => row.id === folder.id);
      const renamedChild = rows.find((row) => row.id === child.id);
      const untouchedSibling = rows.find((row) => row.id === sibling.id);
      expect(renamedFolder).toMatchObject({ id: folder.id, path: 'z', storageKey: null });
      expect(renamedChild).toMatchObject({
        id: child.id,
        path: 'z/b/c.txt',
        storageKey: 'z/b/c.txt',
      });
      expect(untouchedSibling).toMatchObject({ id: sibling.id, path: 'a-sibling.txt' });
    });

    it('preserves the file id an agent_files grant references across a subtree rename (issue #131)', async () => {
      const repo = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      const file = await repo.putFile({
        path: 'assigned/note.txt',
        kind: 'file',
        storageKey: 'assigned/note.txt',
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

      await repo.renameFilesByPrefix!('assigned', 'moved');

      const grant = await isolated.db
        .select({ fileId: agentFiles.fileId })
        .from(agentFiles)
        .where(and(eq(agentFiles.workspaceId, workspaceId), eq(agentFiles.agentId, agentId)));
      expect(grant).toEqual([{ fileId: file.id }]);
      const rows = await repo.listFiles();
      expect(rows.find((row) => row.id === file.id)).toMatchObject({ path: 'moved/note.txt' });
    });

    it('does not touch another workspace, and is a no-op when nothing is under the prefix', async () => {
      const a = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      const b = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeB);
      const otherWorkspaceFile = await b.putFile({
        path: 'shared-prefix/x.txt',
        kind: 'file',
        storageKey: 'shared-prefix/x.txt',
        sizeBytes: 1,
        contentType: null,
        ownerPrincipalId: principalB,
        createdBy: userB,
      });

      await expect(a.renameFilesByPrefix!('shared-prefix', 'renamed-prefix')).resolves.toEqual([]);
      const stillThere = await b.listFiles();
      expect(stillThere.find((row) => row.id === otherWorkspaceFile.id)).toMatchObject({
        path: 'shared-prefix/x.txt',
      });

      await expect(a.deleteFilesByPrefix!('does-not-exist')).resolves.toBeUndefined();
    });

    it('deleteFilesByPrefix removes a folder and its descendants, never a same-prefixed sibling', async () => {
      const repo = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      const folder = await repo.putFile({
        path: 'to-delete',
        kind: 'folder',
        storageKey: null,
        sizeBytes: 0,
        contentType: null,
        ownerPrincipalId: principalA,
        createdBy: userA,
      });
      const child = await repo.putFile({
        path: 'to-delete/child.txt',
        kind: 'file',
        storageKey: 'to-delete/child.txt',
        sizeBytes: 1,
        contentType: null,
        ownerPrincipalId: principalA,
        createdBy: userA,
      });
      const sibling = await repo.putFile({
        path: 'to-delete-sibling.txt',
        kind: 'file',
        storageKey: 'to-delete-sibling.txt',
        sizeBytes: 1,
        contentType: null,
        ownerPrincipalId: principalA,
        createdBy: userA,
      });

      await repo.deleteFilesByPrefix!('to-delete');

      const rows = await repo.listFiles();
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
      const folder = await repo.putFile({
        path: prefix,
        kind: 'folder',
        storageKey: null,
        sizeBytes: 0,
        contentType: null,
        ownerPrincipalId: principalA,
        createdBy: userA,
      });
      const child = await repo.putFile({
        path: `${prefix}/inner.txt`,
        kind: 'file',
        storageKey: `${prefix}/inner.txt`,
        sizeBytes: 1,
        contentType: 'text/plain',
        ownerPrincipalId: principalA,
        createdBy: userA,
      });
      const sibling = await repo.putFile({
        path: `${prefix}-sibling.txt`,
        kind: 'file',
        storageKey: `${prefix}-sibling.txt`,
        sizeBytes: 1,
        contentType: null,
        ownerPrincipalId: principalA,
        createdBy: userA,
      });

      const renamed = await repo.renameFilesByPrefix!(prefix, 'moved-emoji');
      expect(renamed.map((row) => row.path).sort()).toEqual([
        'moved-emoji',
        'moved-emoji/inner.txt',
      ]);

      const rowsAfterRename = await repo.listFiles();
      expect(rowsAfterRename.find((row) => row.id === folder.id)).toMatchObject({
        path: 'moved-emoji',
        storageKey: null,
      });
      expect(rowsAfterRename.find((row) => row.id === child.id)).toMatchObject({
        path: 'moved-emoji/inner.txt',
        storageKey: 'moved-emoji/inner.txt',
      });
      expect(rowsAfterRename.find((row) => row.id === sibling.id)).toMatchObject({
        path: `${prefix}-sibling.txt`,
      });

      await repo.deleteFilesByPrefix!('moved-emoji');

      const rowsAfterDelete = await repo.listFiles();
      expect(rowsAfterDelete.find((row) => row.id === folder.id)).toBeUndefined();
      expect(rowsAfterDelete.find((row) => row.id === child.id)).toBeUndefined();
      expect(rowsAfterDelete.find((row) => row.id === sibling.id)).toMatchObject({
        path: `${prefix}-sibling.txt`,
      });
    });
  });
  describe('deleteSkill (issue #240)', () => {
    it('refuses an assigned skill naming the agent, conceals another workspace, then deletes', async () => {
      const a = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      const b = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeB);
      const skill = await a.putSkill({
        name: 'assigned-skill',
        skillMd: '# assigned',
        enabled: true,
        ownerPrincipalId: principalA,
        createdBy: userA,
      });
      const agentId = crypto.randomUUID();
      await isolated.db.insert(agents).values({
        id: agentId,
        workspaceId: scopeA.workspaceId,
        name: 'Skill assignee',
        instructions: '',
        modelConnectionId: null,
        model: null,
        permissions: {
          readFiles: false,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
        ownerPrincipalId: principalA,
        createdBy: userA,
      });
      await isolated.db
        .insert(agentSkills)
        .values({ workspaceId: scopeA.workspaceId, agentId, skillId: skill.id });

      await expect(a.deleteSkill('assigned-skill')).resolves.toEqual({
        kind: 'in-use',
        agentIds: [agentId],
      });
      expect((await a.listSkills()).map((row) => row.id)).toContain(skill.id);

      // Another workspace names the same skill and finds nothing — and deletes nothing.
      await expect(b.deleteSkill('assigned-skill')).resolves.toEqual({ kind: 'not-found' });
      expect((await a.listSkills()).map((row) => row.id)).toContain(skill.id);

      await isolated.db.delete(agentSkills).where(eq(agentSkills.skillId, skill.id));
      await expect(a.deleteSkill('assigned-skill')).resolves.toMatchObject({
        kind: 'deleted',
        skill: { id: skill.id, name: 'assigned-skill' },
      });
      expect((await a.listSkills()).map((row) => row.id)).not.toContain(skill.id);
      await expect(a.deleteSkill('assigned-skill')).resolves.toEqual({ kind: 'not-found' });
    });
  });
});
