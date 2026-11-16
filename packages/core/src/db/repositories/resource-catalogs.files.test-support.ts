import { eq, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { StorageArea } from '../../storage/storage-areas.js';
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

export function describeCatalogFileTests(): void {
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
}
