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
  createDatabaseResourceCatalogRepositoryProvider,
  STALE_SKILL_REVISION_MS,
} from './resource-catalogs.js';
import { createDatabaseWorkspaceScopeResolver, type WorkspaceScope } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';
import { seedCatalogFile } from './catalog-fixtures.js';
import { listCatalogFiles } from './resource-catalogs.js';

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
    unassign: (workspace, skill, agentId) =>
      Promise.resolve().then(() =>
        provider.forWorkspace(workspaceIds[workspace]).unassignSkill(skill.name, agentId),
      ),
    ageRevisions: (name) =>
      Promise.resolve().then(() => provider.forWorkspace(workspaceIds.a).ageSkillRevisions(name)),
  });
});

it('failNext rejects the next call of one operation, once', async () => {
  const provider = createInMemoryCatalog();
  const catalog = provider.forWorkspace(crypto.randomUUID());
  const input = {
    ownerPrincipalId: crypto.randomUUID(),
    sizeBytes: 1,
    contentType: null,
    objectId: crypto.randomUUID(),
  };
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
      unassign: async (workspace, skill, agentId) => {
        const seeded = workspace === 'a' ? a : b;
        await isolated.db
          .delete(agentSkills)
          .where(
            and(
              eq(agentSkills.workspaceId, seeded.scope.workspaceId),
              eq(agentSkills.agentId, agentId),
              eq(agentSkills.skillId, skill.id),
            ),
          );
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

  it('keeps a file id across a rename and a skill id across an upsert', async () => {
    const repo = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
    const file = await seedCatalogFile(repo, {
      path: 'handbook/readme.md',
      kind: 'file',
      sizeBytes: 12,
      contentType: 'text/markdown',
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    await expect(repo.rename(file.path, 'handbook/renamed.md')).resolves.toEqual({
      rows: 1,
      files: 1,
    });
    await expect(repo.get('handbook/renamed.md')).resolves.toMatchObject({ id: file.id });
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
      objectId: crypto.randomUUID(),
      sizeBytes: 4,
      ownerPrincipalId: principalA,
      status: 'pending',
    });
    const ready = await seedCatalogFile(repo, {
      path: 'inbox/ready.bin',
      kind: 'file',
      sizeBytes: 4,
      contentType: null,
      ownerPrincipalId: principalA,
    });
    const listed = await listCatalogFiles(repo);
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
    await seedCatalogFile(repo, {
      path: 'implied/parent/leaf.txt',
      kind: 'file',
      sizeBytes: 1,
      contentType: null,
      ownerPrincipalId: principalA,
    });
    const folders = (await listCatalogFiles(repo)).filter(
      (file) => file.path === 'implied' || file.path === 'implied/parent',
    );
    expect(folders).toHaveLength(2);
    expect(folders.every((folder) => folder.kind === 'folder' && folder.status === 'ready')).toBe(
      true,
    );
  });

  // @story US-STO-02
  it('[US-STO-02][contract][sdk] a parent folder is not added beside a pending file at its path', async () => {
    const repo = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
    await repo.reserve('shadowed-by-pending', {
      objectId: crypto.randomUUID(),
      ownerPrincipalId: principalA,
      sizeBytes: 1,
      contentType: null,
    });
    await seedCatalogFile(repo, {
      path: 'shadowed-by-pending/child.txt',
      kind: 'file',
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

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] a re-reserve writes the pending row only when it declares something new', async () => {
    // Every loser of a reserve burst is such a retry, and each one commits under the path lock in
    // turn: a write there costs a transaction id and a WAL flush per loser, serialized.
    const repo = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
    const input = { ownerPrincipalId: principalA, sizeBytes: 3, contentType: 'text/plain' };
    const objectIds = new Map<string, string>();
    const objectIdOf = (path: string): string => {
      const id = objectIds.get(path) ?? crypto.randomUUID();
      objectIds.set(path, id);
      return id;
    };
    const version = async (id: string) => {
      const result = await isolated.db.execute(
        sql`select xmin::text as version from ${files} where ${files.id} = ${id}`,
      );
      return (result.rows[0] as { version?: unknown } | undefined)?.version;
    };
    for (const uploadMode of [undefined, 'relay', 'signed'] as const) {
      const path = `rewrite-check/${uploadMode ?? 'none'}.bin`;
      const named = { ...input, objectId: objectIdOf(path) };
      const declared = uploadMode === undefined ? named : { ...named, uploadMode };
      const reserved = await repo.reserve(path, declared);
      const before = await version(reserved.row.id);

      const retried = await repo.reserve(path, declared);
      expect(retried).toMatchObject({ kind: 'taken', row: { id: reserved.row.id } });
      // A signed re-mint always issues a new reservation; any other unchanged retry is a read.
      if (uploadMode === 'signed') {
        expect(retried.row.reservationToken).not.toBe(reserved.row.reservationToken);
        expect(await version(reserved.row.id)).not.toBe(before);
      } else {
        expect(retried.row).toEqual(reserved.row);
        expect(await version(reserved.row.id)).toBe(before);
      }
    }
    const resized = await repo.reserve('rewrite-check/none.bin', {
      ...input,
      objectId: objectIdOf('rewrite-check/none.bin'),
      sizeBytes: 4,
    });
    expect(resized.row).toMatchObject({ sizeBytes: 4 });
    await expect(repo.pending('rewrite-check/none.bin')).resolves.toMatchObject({ sizeBytes: 4 });
  });

  describe('the files checks', () => {
    const row = (path: string, extra: { sha256?: string; area?: StorageArea } = {}) => ({
      workspaceId: scopeA.workspaceId,
      path,
      kind: 'file' as const,
      storageKey: path,
      objectId: crypto.randomUUID(),
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
          sql`insert into files (workspace_id, path, kind, storage_key, object_id, owner_principal_id, area)
            values (${scopeA.workspaceId}, 'area/bad.bin', 'file', 'area/bad.bin', ${crypto.randomUUID()}, ${principalA}, 'elsewhere')`,
        ),
      ).rejects.toMatchObject({ cause: { code: '23514', constraint: 'files_area_valid' } });
      await isolated.db.insert(files).values(row('area/good.bin', { area: 'staging' }));
    });
  });

  // STO-113 #2: every reserve counts the workspace's pending uploads (`countPending`), so the count
  // must not scan the workspace's ready rows, which are nearly all of them.
  it('counts pending uploads through a partial index of the pending rows', async () => {
    const indexes = await isolated.db.execute<{ indexdef: string }>(sql`
      select indexdef from pg_indexes
      where schemaname = 'public' and indexname = 'files_workspace_pending_updated_idx'
    `);
    expect(indexes.rows.map((row) => row.indexdef)).toEqual([
      expect.stringMatching(
        /ON public\.files USING btree \(workspace_id, updated_at\) WHERE \(status = 'pending'::text\)$/u,
      ),
    ]);
    const plan = await isolated.db.transaction(async (tx) => {
      // Only so that the plan does not depend on how few rows this test database holds.
      await tx.execute(sql`set local enable_seqscan = off`);
      return tx.execute<{ 'QUERY PLAN': string }>(sql`
        explain select count(*) from files
        where workspace_id = ${scopeA.workspaceId} and status = 'pending' and area <> 'staging'
          and updated_at >= ${new Date(0).toISOString()}
      `);
    });
    expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n')).toContain(
      'files_workspace_pending_updated_idx',
    );
  });

  it('keeps equal paths and names isolated by workspace', async () => {
    const a = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
    const b = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeB);
    const fileA = await seedCatalogFile(a, {
      path: 'same.txt',
      kind: 'file',
      sizeBytes: 1,
      contentType: null,
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    const fileB = await seedCatalogFile(b, {
      path: 'same.txt',
      kind: 'file',
      sizeBytes: 2,
      contentType: null,
      ownerPrincipalId: principalB,
      createdBy: userB,
    });
    expect(fileA.id).not.toBe(fileB.id);
    expect((await listCatalogFiles(a)).map((file) => file.id)).not.toContain(fileB.id);
  });

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
