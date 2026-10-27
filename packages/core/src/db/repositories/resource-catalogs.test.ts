import crypto from 'node:crypto';

import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agentFiles } from '../schema/agent-files.js';
import { agentSkills } from '../schema/agent-skills.js';
import { agents } from '../schema/agents.js';
import { files } from '../schema/files.js';
import { skillRevisions } from '../schema/skill-revisions.js';
import { skills } from '../schema/skills.js';
import { memberships } from '../schema/memberships.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import type { StorageArea } from '../../storage/storage-areas.js';
import { createInMemoryCatalog } from './memory-catalog.js';
import {
  describeCatalogConformance,
  describeSkillCatalogConformance,
} from './resource-catalogs.contract.js';
import {
  CatalogPathPendingError,
  createDatabaseResourceCatalogRepositoryProvider,
  STALE_SKILL_REVISION_MS,
} from './resource-catalogs.js';
import { createDatabaseWorkspaceScopeResolver, type WorkspaceScope } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describeCatalogConformance('the in-memory catalog', () => {
  const provider = createInMemoryCatalog();
  const workspaceIds = { a: crypto.randomUUID(), b: crypto.randomUUID() };
  const ownerA = crypto.randomUUID();
  const ownerB = crypto.randomUUID();
  return Promise.resolve({
    catalog: (workspace) => provider.forWorkspace(workspaceIds[workspace]),
    ownerA,
    ownerB,
    actorA: crypto.randomUUID(),
    seed: (workspace, row) =>
      Promise.resolve().then(() =>
        provider
          .forWorkspace(workspaceIds[workspace])
          .seed({ ...row, ownerPrincipalId: workspace === 'a' ? ownerA : ownerB }),
      ),
  });
});

describeSkillCatalogConformance('the in-memory catalog', () => {
  const provider = createInMemoryCatalog();
  const workspaceIds = { a: crypto.randomUUID(), b: crypto.randomUUID() };
  return Promise.resolve({
    catalog: (workspace) => provider.forWorkspace(workspaceIds[workspace]),
    ownerA: crypto.randomUUID(),
    ownerB: crypto.randomUUID(),
    actorA: crypto.randomUUID(),
    assign: (workspace, skill) => {
      const agentId = crypto.randomUUID();
      provider.forWorkspace(workspaceIds[workspace]).assignSkill(skill.name, agentId);
      return Promise.resolve(agentId);
    },
    ageRevisions: (name) =>
      Promise.resolve().then(() => provider.forWorkspace(workspaceIds.a).ageSkillRevisions(name)),
  });
});

it('failNext rejects the next call of one operation, once', async () => {
  const provider = createInMemoryCatalog();
  const catalog = provider.forWorkspace(crypto.randomUUID());
  const input = { ownerPrincipalId: crypto.randomUUID(), sizeBytes: 1, contentType: null };
  provider.failNext('reserve', new Error('store down'));
  await expect(catalog.get('a.txt')).resolves.toBeNull();
  await expect(catalog.reserve('a.txt', input)).rejects.toThrow('store down');
  await expect(catalog.reserve('a.txt', input)).resolves.toMatchObject({ kind: 'reserved' });
});

/** One workspace with an owner membership and its principal; `created_by` is tenant-paired (issue #117). */
async function seedWorkspace(db: IsolatedTestDatabase['db'], slug: string) {
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
  await db
    .insert(users)
    .values({ id: userId, email: `${userId}@example.test`, name: `Owner ${slug}` });
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
  });
  const scope = await createDatabaseWorkspaceScopeResolver(db).forWorkspaceId(workspaceId);
  if (scope === null) throw new Error('catalog scope did not resolve');
  return { scope, userId, principalId };
}

describe.skipIf(!hasDatabase)('ResourceCatalogRepository against PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  let scopeA: WorkspaceScope;
  let scopeB: WorkspaceScope;
  let userA: string;
  let userB: string;
  let principalA: string;
  let principalB: string;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_resource_catalogs');
    const a = await seedWorkspace(isolated.db, 'catalog-a');
    const b = await seedWorkspace(isolated.db, 'catalog-b');
    ({ scope: scopeA, userId: userA, principalId: principalA } = a);
    ({ scope: scopeB, userId: userB, principalId: principalB } = b);
  }, 180_000);

  describeCatalogConformance('the PostgreSQL catalog', async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const a = await seedWorkspace(isolated.db, `conformance-a-${suffix}`);
    const b = await seedWorkspace(isolated.db, `conformance-b-${suffix}`);
    const provider = createDatabaseResourceCatalogRepositoryProvider(isolated.db);
    return {
      catalog: (workspace) => provider.forScope(workspace === 'a' ? a.scope : b.scope),
      ownerA: a.principalId,
      ownerB: b.principalId,
      actorA: a.userId,
      seed: async (workspace, row) => {
        const seeded = workspace === 'a' ? a : b;
        await isolated.db.insert(files).values({
          workspaceId: seeded.scope.workspaceId,
          path: row.path,
          kind: 'file',
          storageKey: row.path,
          ownerPrincipalId: seeded.principalId,
          status: row.status,
          objectId: row.objectId ?? null,
        });
      },
    };
  });

  describeSkillCatalogConformance('the PostgreSQL catalog', async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const a = await seedWorkspace(isolated.db, `skills-a-${suffix}`);
    const b = await seedWorkspace(isolated.db, `skills-b-${suffix}`);
    const provider = createDatabaseResourceCatalogRepositoryProvider(isolated.db);
    return {
      catalog: (workspace) => provider.forScope(workspace === 'a' ? a.scope : b.scope),
      ownerA: a.principalId,
      ownerB: b.principalId,
      actorA: a.userId,
      assign: async (workspace, skill) => {
        const seeded = workspace === 'a' ? a : b;
        const agentId = crypto.randomUUID();
        await isolated.db.insert(agents).values({
          id: agentId,
          workspaceId: seeded.scope.workspaceId,
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
          ownerPrincipalId: seeded.principalId,
          createdBy: seeded.userId,
        });
        await isolated.db
          .insert(agentSkills)
          .values({ workspaceId: seeded.scope.workspaceId, agentId, skillId: skill.id });
        return agentId;
      },
      ageRevisions: async (name) => {
        await isolated.db
          .update(skillRevisions)
          .set({
            createdAt: sql`${skillRevisions.createdAt} - make_interval(secs => ${STALE_SKILL_REVISION_MS / 1000 + 1})`,
          })
          .where(
            and(
              eq(skillRevisions.workspaceId, a.scope.workspaceId),
              eq(skillRevisions.pending, true),
              inArray(
                skillRevisions.skillId,
                isolated.db
                  .select({ id: skills.id })
                  .from(skills)
                  .where(and(eq(skills.workspaceId, a.scope.workspaceId), eq(skills.name, name))),
              ),
            ),
          );
      },
    };
  });

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

  // @story US-STO-02
  it('[US-STO-02][contract][sdk] a pending file row is invisible to listFiles', async () => {
    const repo = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
    await isolated.db.insert(files).values({
      workspaceId: scopeA.workspaceId,
      path: 'inbox/pending.bin',
      kind: 'file',
      storageKey: 'inbox/pending.bin',
      sizeBytes: 4,
      ownerPrincipalId: principalA,
      status: 'pending',
    });
    const ready = await repo.putFile({
      path: 'inbox/ready.bin',
      kind: 'file',
      storageKey: 'inbox/ready.bin',
      sizeBytes: 4,
      contentType: null,
      ownerPrincipalId: principalA,
    });
    const listed = await repo.listFiles();
    expect(listed.map((file) => file.path)).not.toContain('inbox/pending.bin');
    expect(listed.find((file) => file.path === ready.path)).toMatchObject({ status: 'ready' });
  });

  // @story US-STO-02
  it('[US-STO-02][contract][sdk] a folder row is always ready', async () => {
    const repo = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
    await expect(
      isolated.db.insert(files).values({
        workspaceId: scopeA.workspaceId,
        path: 'pending-folder',
        kind: 'folder',
        ownerPrincipalId: principalA,
        status: 'pending',
      }),
    ).rejects.toMatchObject({ cause: { code: '23514', constraint: 'files_folder_is_ready' } });
    await repo.putFile({
      path: 'implied/parent/leaf.txt',
      kind: 'file',
      storageKey: 'implied/parent/leaf.txt',
      sizeBytes: 1,
      contentType: null,
      ownerPrincipalId: principalA,
    });
    const folders = (await repo.listFiles()).filter(
      (file) => file.path === 'implied' || file.path === 'implied/parent',
    );
    expect(folders).toHaveLength(2);
    expect(folders.every((folder) => folder.kind === 'folder' && folder.status === 'ready')).toBe(
      true,
    );
  });

  // @story US-STO-02
  it('[US-STO-02][contract][sdk] putFile over a pending row is refused and leaves it pending', async () => {
    const repo = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
    const [pending] = await isolated.db
      .insert(files)
      .values({
        workspaceId: scopeA.workspaceId,
        path: 'inbox/reserved.bin',
        kind: 'file',
        storageKey: 'inbox/reserved.bin',
        sizeBytes: 4,
        ownerPrincipalId: principalA,
        status: 'pending',
      })
      .returning({ id: files.id });
    await expect(
      repo.putFile({
        path: 'inbox/reserved.bin',
        kind: 'file',
        storageKey: 'inbox/reserved.bin',
        sizeBytes: 4,
        contentType: null,
        ownerPrincipalId: principalA,
      }),
    ).rejects.toBeInstanceOf(CatalogPathPendingError);
    await expect(repo.get('inbox/reserved.bin', { includePending: true })).resolves.toMatchObject({
      id: pending?.id,
      status: 'pending',
    });
  });

  // @story US-STO-02
  it('[US-STO-02][contract][sdk] a parent folder is not added beside a pending file at its path', async () => {
    const repo = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
    await repo.reserve('shadowed-by-pending', {
      ownerPrincipalId: principalA,
      sizeBytes: 1,
      contentType: null,
    });
    await repo.putFile({
      path: 'shadowed-by-pending/child.txt',
      kind: 'file',
      storageKey: 'shadowed-by-pending/child.txt',
      sizeBytes: 1,
      contentType: null,
      ownerPrincipalId: principalA,
    });
    const rows = await isolated.db
      .select()
      .from(files)
      .where(eq(files.path, 'shadowed-by-pending'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'file', status: 'pending' });
  });

  describe('the files checks', () => {
    const row = (path: string, extra: { sha256?: string; area?: StorageArea } = {}) => ({
      workspaceId: scopeA.workspaceId,
      path,
      kind: 'file' as const,
      storageKey: path,
      ownerPrincipalId: principalA,
      ...extra,
    });

    // @story US-STO-02
    it('[US-STO-02][contract][sdk] refuses a sha256 that is not 64 lowercase hex characters', async () => {
      const refused = ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), ''];
      for (const [index, sha256] of refused.entries()) {
        await expect(
          isolated.db.insert(files).values(row(`sha/bad-${String(index)}.bin`, { sha256 })),
        ).rejects.toMatchObject({ cause: { code: '23514', constraint: 'files_sha256_shape' } });
      }
      await isolated.db.insert(files).values(row('sha/good.bin', { sha256: '0'.repeat(64) }));
    });

    // @story US-STO-02
    it('[US-STO-02][contract][sdk] refuses an unknown area', async () => {
      await expect(
        isolated.db.execute(
          sql`insert into files (workspace_id, path, kind, storage_key, owner_principal_id, area)
            values (${scopeA.workspaceId}, 'area/bad.bin', 'file', 'area/bad.bin', ${principalA}, 'elsewhere')`,
        ),
      ).rejects.toMatchObject({ cause: { code: '23514', constraint: 'files_area_valid' } });
      await isolated.db.insert(files).values(row('area/good.bin', { area: 'staging' }));
    });
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

      const renamed = await a.renameFilesByPrefix('prefix-source', 'prefix-target/inner');
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

      const renamed = await repo.renameFilesByPrefix('a', 'z');
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

      await repo.renameFilesByPrefix('assigned', 'moved');

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

      await expect(a.renameFilesByPrefix('shared-prefix', 'renamed-prefix')).resolves.toEqual([]);
      const stillThere = await b.listFiles();
      expect(stillThere.find((row) => row.id === otherWorkspaceFile.id)).toMatchObject({
        path: 'shared-prefix/x.txt',
      });

      await expect(a.deleteFilesByPrefix('does-not-exist')).resolves.toBeUndefined();
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

      await repo.deleteFilesByPrefix('to-delete');

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

      const renamed = await repo.renameFilesByPrefix(prefix, 'moved-emoji');
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

      await repo.deleteFilesByPrefix('moved-emoji');

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
  describe('skill revisions (SDK-19, N-1)', () => {
    const skillInput = (name: string) => ({
      name,
      skillMd: `# ${name}`,
      enabled: true,
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    const noWrite = () => Promise.resolve(undefined);

    it('numbers revisions 1, 2, 3 per skill, lists newest first and hides them from other workspaces', async () => {
      const a = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      const b = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeB);
      await a.putSkill(skillInput('numbered'));
      await a.putSkill(skillInput('numbered-other'));
      const written: number[] = [];
      const write = (n: number) => {
        written.push(n);
        return Promise.resolve(undefined);
      };
      const first = await a.publishSkillRevision('numbered', { fileCount: 1, write });
      const second = await a.publishSkillRevision('numbered', { fileCount: 3, write });
      const other = await a.publishSkillRevision('numbered-other', {
        fileCount: 1,
        write: noWrite,
      });
      expect([first?.number, second?.number, other?.number]).toEqual([1, 2, 1]);
      expect(written).toEqual([1, 2]);
      expect((await a.listSkillRevisions('numbered')).map((r) => [r.number, r.fileCount])).toEqual([
        [2, 3],
        [1, 1],
      ]);
      await expect(b.listSkillRevisions('numbered')).resolves.toEqual([]);
      await expect(
        b.publishSkillRevision('numbered', { fileCount: 1, write: noWrite }),
      ).resolves.toBeNull();
      await expect(
        a.publishSkillRevision('missing', { fileCount: 1, write: noWrite }),
      ).resolves.toBeNull();
    });

    it('gives concurrent publishes distinct numbers', async () => {
      const a = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      await a.putSkill(skillInput('concurrent'));
      const published = await Promise.all(
        Array.from({ length: 5 }, () =>
          a.publishSkillRevision('concurrent', { fileCount: 1, write: noWrite }),
        ),
      );
      expect(published.map((r) => r?.number).sort()).toEqual([1, 2, 3, 4, 5]);
    });

    it('records nothing and reuses the number when the object-store write fails', async () => {
      const a = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      await a.putSkill(skillInput('flaky'));
      await expect(
        a.publishSkillRevision('flaky', {
          fileCount: 1,
          write: () => Promise.reject(new Error('store down')),
        }),
      ).rejects.toThrow('store down');
      await expect(a.listSkillRevisions('flaky')).resolves.toEqual([]);
      await expect(
        a.publishSkillRevision('flaky', { fileCount: 1, write: noWrite }),
      ).resolves.toMatchObject({ number: 1 });
    });

    it('refuses a second row for a published number and leaves the row alone when the skill changes', async () => {
      const a = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      const skill = await a.putSkill(skillInput('frozen-row'));
      const first = await a.publishSkillRevision('frozen-row', { fileCount: 2, write: noWrite });
      await expect(
        isolated.db
          .insert(skillRevisions)
          .values({ workspaceId: scopeA.workspaceId, skillId: skill.id, number: 1, fileCount: 9 }),
      ).rejects.toThrow();

      await a.putSkill({ ...skillInput('frozen-row'), skillMd: '# changed', enabled: false });
      const second = await a.publishSkillRevision('frozen-row', { fileCount: 5, write: noWrite });
      expect(second?.number).toBe(2);
      expect(await a.listSkillRevisions('frozen-row')).toEqual([second, first]);
    });

    it('lets an assignment pin only a revision that exists, and cascades revisions with the skill', async () => {
      const a = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      const skill = await a.putSkill(skillInput('pinned'));
      await a.publishSkillRevision('pinned', { fileCount: 1, write: noWrite });
      const agentId = crypto.randomUUID();
      await isolated.db.insert(agents).values({
        id: agentId,
        workspaceId: scopeA.workspaceId,
        name: 'Pinning agent',
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
      const assignment = { workspaceId: scopeA.workspaceId, agentId, skillId: skill.id };
      await expect(
        isolated.db.insert(agentSkills).values({ ...assignment, revision: 2 }),
      ).rejects.toThrow();
      await isolated.db.insert(agentSkills).values({ ...assignment, revision: 1 });
      await expect(a.deleteSkill('pinned')).resolves.toMatchObject({ kind: 'in-use' });

      await isolated.db.delete(agentSkills).where(eq(agentSkills.skillId, skill.id));
      await expect(a.deleteSkill('pinned')).resolves.toMatchObject({ kind: 'deleted' });
      await expect(
        isolated.db.select().from(skillRevisions).where(eq(skillRevisions.skillId, skill.id)),
      ).resolves.toEqual([]);
    });
  });
});
