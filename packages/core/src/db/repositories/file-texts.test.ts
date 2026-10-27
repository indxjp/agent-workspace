import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fileTexts } from '../schema/file-texts.js';
import { files } from '../schema/files.js';
import { memberships } from '../schema/memberships.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseFileTextRepositoryProvider } from './file-texts.js';
import { createDatabaseResourceCatalogRepositoryProvider } from './resource-catalogs.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

/** What the application's tokeniser would write for `保守手順`; the repository stores it as given. */
const MAINTENANCE = { terms: '保守 守手 手順', text: '保守手順' };

describe.skipIf(!hasDatabase)('FileTextRepository', () => {
  let isolated: IsolatedTestDatabase;
  const tenants = ['a', 'b'].map(() => ({
    workspaceId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    membershipId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
  }));
  const [a, b] = tenants;
  if (a === undefined || b === undefined) throw new Error('unreachable');

  async function scope(workspaceId: string) {
    const resolved = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (resolved === null) throw new Error('workspace did not resolve');
    return resolved;
  }
  const texts = async (tenant: typeof a) =>
    createDatabaseFileTextRepositoryProvider(isolated.db).forScope(await scope(tenant.workspaceId));
  const catalog = async (tenant: typeof a) =>
    createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(
      await scope(tenant.workspaceId),
    );
  const put = async (tenant: typeof a, path: string, sizeBytes = 10) =>
    (await catalog(tenant)).putFile({
      path,
      kind: 'file',
      storageKey: `k/${crypto.randomUUID()}`,
      sizeBytes,
      contentType: 'application/pdf',
      ownerPrincipalId: tenant.principalId,
    });

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_file_texts');
    for (const tenant of tenants) {
      await isolated.db
        .insert(workspaces)
        .values({ id: tenant.workspaceId, slug: tenant.workspaceId, name: 'Texts' });
      await isolated.db
        .insert(users)
        .values({ id: tenant.userId, email: `${tenant.userId}@example.test`, name: 'Owner' });
      await isolated.db.transaction(async (tx) => {
        await tx.insert(memberships).values({
          id: tenant.membershipId,
          workspaceId: tenant.workspaceId,
          userId: tenant.userId,
          role: 'owner',
        });
        await tx.insert(workspacePrincipals).values({
          id: tenant.principalId,
          workspaceId: tenant.workspaceId,
          kind: 'membership',
          membershipId: tenant.membershipId,
        });
      });
    }
  }, 180_000);

  afterAll(async () => isolated.close());

  it('lists a new file as stale, stores its text, and finds it by a Japanese bigram query', async () => {
    const file = await put(a, 'manuals/pump.pdf');
    const repo = await texts(a);
    const stale = (await repo.listStale()).find((entry) => entry.id === file.id);
    expect(stale?.path).toBe('manuals/pump.pdf');

    await expect(
      repo.replace(file.id, stale ?? { sizeBytes: 0, updatedAt: '' }, [
        { page: 3, text: MAINTENANCE.text, terms: MAINTENANCE.terms },
      ]),
    ).resolves.toBe(true);

    expect((await repo.listStale()).some((entry) => entry.id === file.id)).toBe(false);
    const hits = await repo.search("'手順'", 10, null);
    expect(hits.map((hit) => [hit.path, hit.page, hit.text])).toEqual([
      ['manuals/pump.pdf', 3, '保守手順'],
    ]);
    expect(hits[0]?.score).toBeGreaterThan(0);
    // Adjacent bigrams only: `保手` is not in the text even though both characters are.
    await expect(repo.search("'保手'", 10, null)).resolves.toEqual([]);
    await expect(repo.search("'保守' <-> '守手' <-> '手順'", 10, null)).resolves.toHaveLength(1);
  });

  it('finds a lone kanji inside a longer run through its prefix query', async () => {
    const file = await put(a, 'cat.pdf');
    const repo = await texts(a);
    const source = (await repo.listStale()).find((entry) => entry.id === file.id);
    if (source === undefined) throw new Error('expected a stale file');
    // `黒猫です` as the tokeniser writes it, and `猫` as `toTsQuery` asks for it.
    await repo.replace(file.id, source, [
      { page: null, text: '黒猫です', terms: '黒猫 猫で です' },
    ]);
    const hits = await repo.search("'猫':*", 10, [file.id]);
    expect(hits.map((hit) => hit.text)).toEqual(['黒猫です']);
  });

  it('replaces idempotently, and a marker row matches nothing but ends staleness', async () => {
    const file = await put(a, 'marker.pdf');
    const repo = await texts(a);
    const source = (await repo.listStale()).find((entry) => entry.id === file.id);
    if (source === undefined) throw new Error('expected a stale file');
    await repo.replace(file.id, source, [{ page: null, text: '', terms: '' }]);
    await repo.replace(file.id, source, [{ page: null, text: '', terms: '' }]);
    expect(
      await isolated.db.select().from(fileTexts).where(eq(fileTexts.fileId, file.id)),
    ).toHaveLength(1);
    expect((await repo.listStale()).some((entry) => entry.id === file.id)).toBe(false);
  });

  it('marks a file stale again when it is overwritten', async () => {
    const file = await put(a, 'versioned.pdf', 10);
    const repo = await texts(a);
    const source = (await repo.listStale()).find((entry) => entry.id === file.id);
    if (source === undefined) throw new Error('expected a stale file');
    await repo.replace(file.id, source, [{ page: null, text: 'old', terms: 'old' }]);
    await put(a, 'versioned.pdf', 10);
    expect((await repo.listStale()).map((entry) => entry.id)).toContain(file.id);
  });

  it('never caches a pending upload, and finds it once confirmed', async () => {
    const repo = await texts(a);
    const reserved = await (
      await catalog(a)
    ).reserve('inbox/pending.pdf', {
      ownerPrincipalId: a.principalId,
      sizeBytes: 10,
      contentType: 'application/pdf',
    });
    expect((await repo.listStale()).map((entry) => entry.id)).not.toContain(reserved.row.id);

    const ready = await (
      await catalog(a)
    ).confirm(reserved.row, { sizeBytes: 10, contentType: 'application/pdf' });
    const source = (await repo.listStale()).find((entry) => entry.id === ready?.row.id);
    if (source === undefined) throw new Error('expected the confirmed file to be stale');
    await repo.replace(source.id, source, [{ page: null, text: '確定', terms: '確定' }]);
    await expect(repo.search("'確定'", 10, [source.id])).resolves.toMatchObject([
      { path: 'inbox/pending.pdf' },
    ]);

    // A re-confirm writes new bytes under the same size: its cached text is stale again.
    await (
      await catalog(a)
    ).confirm(reserved.row, { sizeBytes: 10, contentType: 'application/pdf', expect: 'any' });
    expect((await repo.listStale()).map((entry) => entry.id)).toContain(source.id);
  });

  it('keeps a hit under the new path after a rename', async () => {
    const file = await put(a, 'before.pdf');
    const repo = await texts(a);
    const source = (await repo.listStale()).find((entry) => entry.id === file.id);
    if (source === undefined) throw new Error('expected a stale file');
    await repo.replace(file.id, source, [{ page: null, text: 'renamed', terms: 'renamedterm' }]);
    await (
      await catalog(a)
    ).renameFile('before.pdf', {
      path: 'after.pdf',
      kind: 'file',
      storageKey: file.storageKey,
      sizeBytes: file.sizeBytes,
      contentType: file.contentType,
    });
    const hits = await repo.search("'renamedterm'", 10, null);
    expect(hits.map((hit) => hit.path)).toEqual(['after.pdf']);
  });

  // @story US-STO-02
  it('[US-STO-02][contract][sdk] neither extracts nor finds a pending upload', async () => {
    const stored = await put(a, 'pending/stored.pdf');
    const repo = await texts(a);
    const source = (await repo.listStale()).find((entry) => entry.id === stored.id);
    if (source === undefined) throw new Error('expected a stale file');
    await repo.replace(stored.id, source, [{ page: null, text: 'x', terms: 'pendingword' }]);
    const fresh = await put(a, 'pending/fresh.pdf');
    await isolated.db.update(files).set({ status: 'pending' }).where(eq(files.id, stored.id));
    await isolated.db.update(files).set({ status: 'pending' }).where(eq(files.id, fresh.id));

    expect((await repo.listStale()).map((entry) => entry.id)).not.toContain(fresh.id);
    await expect(repo.search("'pendingword'", 10, null)).resolves.toEqual([]);
    await expect(repo.search("'pendingword'", 10, [stored.id])).resolves.toEqual([]);
  });

  it('narrows to allowed files, and an empty allow-list matches nothing', async () => {
    const file = await put(a, 'allowed/one.pdf');
    const other = await put(a, 'denied/two.pdf');
    const repo = await texts(a);
    for (const entry of await repo.listStale()) {
      await repo.replace(entry.id, entry, [{ page: null, text: 'shared', terms: 'sharedword' }]);
    }
    const hits = await repo.search("'sharedword'", 50, [file.id]);
    expect(hits.map((hit) => hit.fileId)).toEqual([file.id]);
    expect(hits.map((hit) => hit.fileId)).not.toContain(other.id);
    await expect(repo.search("'sharedword'", 50, [])).resolves.toEqual([]);
  });

  it('is invisible to another workspace, and refuses to write another workspace file', async () => {
    const file = await put(a, 'secret.pdf');
    const repoA = await texts(a);
    const source = (await repoA.listStale()).find((entry) => entry.id === file.id);
    if (source === undefined) throw new Error('expected a stale file');
    await repoA.replace(file.id, source, [{ page: null, text: 'x', terms: 'tenantsecret' }]);

    const repoB = await texts(b);
    await expect(repoB.search("'tenantsecret'", 10, null)).resolves.toEqual([]);
    expect((await repoB.listStale()).map((entry) => entry.id)).not.toContain(file.id);
    await expect(
      repoB.replace(file.id, source, [{ page: null, text: 'x', terms: 'forged' }]),
    ).resolves.toBe(false);
    await expect(repoA.search("'forged'", 10, null)).resolves.toEqual([]);
  });

  it('deletes cached text with the file', async () => {
    const file = await put(a, 'gone.pdf');
    const repo = await texts(a);
    const source = (await repo.listStale()).find((entry) => entry.id === file.id);
    if (source === undefined) throw new Error('expected a stale file');
    await repo.replace(file.id, source, [{ page: null, text: 'x', terms: 'goneword' }]);
    await (await catalog(a)).deleteFile('gone.pdf');
    expect(await isolated.db.select().from(fileTexts).where(eq(fileTexts.fileId, file.id))).toEqual(
      [],
    );
    await expect(repo.replace(file.id, source, [])).resolves.toBe(false);
  });
});
