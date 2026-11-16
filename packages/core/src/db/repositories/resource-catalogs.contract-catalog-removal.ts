import { expect, it } from 'vitest';
import { sidePath } from '../side-paths.js';
import { paths, upload } from './resource-catalogs.contract-catalog-fixtures.js';

import type { CatalogConformanceFixture } from './resource-catalogs.contract-fixture.js';
export function registerCatalogRemovalTests(
  makeFixture: () => Promise<CatalogConformanceFixture>,
): void {
  // @story US-STO-04
  it('[US-STO-04][contract][sdk] removing a folder marks every row under it deleting', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    await upload(a, ownerA, 'docs/sub/a.txt');
    await a.reserve('docs/pending.bin', {
      objectId: crypto.randomUUID(),
      ownerPrincipalId: ownerA,
      sizeBytes: 1,
      contentType: null,
    });
    await upload(a, ownerA, 'docs2/b.txt');

    // The file rows come back deleting, moved aside with their old path in `targetPath`; the
    // folder rows (docs, docs/sub) have no object to clean up.
    const removed = await a.remove('docs');
    expect(removed.map((row) => [row.targetPath, row.status]).sort()).toEqual([
      ['docs/pending.bin', 'deleting'],
      ['docs/sub/a.txt', 'deleting'],
    ]);
    for (const row of removed) expect(row.path).toBe(sidePath(row.id));

    expect(paths((await a.list('')).rows)).toEqual(['docs2', 'docs2/b.txt']);
    for (const path of ['docs', 'docs/sub', 'docs/sub/a.txt', 'docs/pending.bin']) {
      await expect(a.get(path, { includePending: true })).resolves.toBeNull();
    }
    expect((await a.deleting()).map((row) => row.targetPath).sort()).toEqual([
      'docs/pending.bin',
      'docs/sub/a.txt',
    ]);
    await expect(a.remove('docs')).resolves.toEqual([]);
  });

  // @story US-STO-04
  it('[US-STO-04][contract][sdk] remove marks a file deleting and get and list stop showing it', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const file = await upload(a, ownerA, 'one.txt');
    await upload(a, ownerA, 'two.txt');

    const removed = await a.remove('one.txt');
    // Removing is a write, so only the write time may differ from the row that was uploaded.
    const written = removed[0]?.updatedAt;
    expect(written).toBeInstanceOf(Date);
    expect(removed).toEqual([
      {
        ...file,
        status: 'deleting',
        path: sidePath(file.id),
        targetPath: 'one.txt',
        updatedAt: written,
      },
    ]);
    await expect(a.get('one.txt')).resolves.toBeNull();
    await expect(a.get('one.txt', { includePending: true })).resolves.toBeNull();
    expect(paths((await a.list('')).rows)).toEqual(['two.txt']);
    await expect(a.deleting()).resolves.toEqual(removed);
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] confirm stores the checksum', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const sha256 = 'ab'.repeat(32);
    const reserved = await a.reserve('sum.bin', {
      objectId: crypto.randomUUID(),
      ownerPrincipalId: ownerA,
      sizeBytes: 1,
      contentType: null,
    });
    await expect(
      a.confirm(reserved.row, { sizeBytes: 1, contentType: null, sha256 }),
    ).resolves.toMatchObject({ row: { status: 'ready', sha256 } });
    await expect(a.get('sum.bin')).resolves.toMatchObject({ sha256 });
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] confirm of a removed row returns null and never revives it', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const reserved = await a.reserve('gone.bin', {
      objectId: crypto.randomUUID(),
      ownerPrincipalId: ownerA,
      sizeBytes: 1,
      contentType: null,
    });
    await a.remove('gone.bin');
    await expect(a.confirm(reserved.row, { sizeBytes: 1, contentType: null })).resolves.toBeNull();
    await expect(a.get('gone.bin', { includePending: true })).resolves.toBeNull();
    await expect(a.deleting()).resolves.toHaveLength(1);
  });

  // @story US-STO-04
  it('[US-STO-04][contract][sdk] a removed path is free at once: reserve wins', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const input = { ownerPrincipalId: ownerA, sizeBytes: 1, contentType: null };
    const reserved = await a.reserve('gone.bin', { ...input, objectId: crypto.randomUUID() });
    await a.remove('gone.bin');
    const again = await a.reserve('gone.bin', { ...input, objectId: crypto.randomUUID() });
    expect(again).toMatchObject({
      kind: 'reserved',
      row: { path: 'gone.bin', status: 'pending' },
    });
    expect(again.row.id).not.toBe(reserved.row.id);
    await expect(a.deleting()).resolves.toHaveLength(1);
  });

  // @story US-STO-04
  it('[US-STO-04][contract][sdk] stalePending returns only pending rows reserved before the cut-off', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    await upload(a, ownerA, 'ready.bin');
    const pending = await a.reserve('pending.bin', {
      objectId: crypto.randomUUID(),
      ownerPrincipalId: ownerA,
      sizeBytes: 1,
      contentType: null,
    });
    const minute = 60_000;

    await expect(a.stalePending(new Date(Date.now() - minute))).resolves.toEqual([]);
    await expect(a.stalePending(new Date(Date.now() + minute))).resolves.toEqual([pending.row]);
  });

  // @story US-STO-04
  it('[US-STO-04][contract][sdk] a re-reserve refreshes the time stalePending compares', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    // A signed re-mint is what refreshes it; an unchanged retry with no mode keeps its snapshot.
    const input = {
      ownerPrincipalId: ownerA,
      sizeBytes: 5,
      contentType: null,
      objectId: crypto.randomUUID(),
      uploadMode: 'signed',
    } as const;
    const first = await a.reserve('again.bin', input);
    if (first.kind !== 'reserved') throw new Error('again.bin was already taken');
    const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
    await pause();
    const cut = new Date();
    await pause();

    await expect(a.stalePending(cut)).resolves.toEqual([first.row]);
    await expect(a.reserve('again.bin', input)).resolves.toMatchObject({ kind: 'taken' });
    await expect(a.stalePending(cut)).resolves.toEqual([]);
  });

  // @story US-STO-04
  it('[US-STO-04][contract][sdk] a fresh reservation is not stale through another handle', async () => {
    const { catalog, ownerA } = await makeFixture();
    const pending = await catalog('a').reserve('pending.bin', {
      objectId: crypto.randomUUID(),
      ownerPrincipalId: ownerA,
      sizeBytes: 1,
      contentType: null,
    });
    const minute = 60_000;

    await expect(catalog('a').stalePending(new Date(Date.now() - minute))).resolves.toEqual([]);
    await expect(catalog('a').stalePending(new Date(Date.now() + minute))).resolves.toEqual([
      pending.row,
    ]);
  });

  // @story US-STO-04
  it('[US-STO-04][contract][sdk] forget is idempotent and never deletes a ready row', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const ready = await upload(a, ownerA, 'keep.bin');
    await upload(a, ownerA, 'doomed.bin');
    const removed = await a.remove('doomed.bin');
    expect(removed).toHaveLength(1);

    await a.forget(ready);
    await expect(a.get('keep.bin')).resolves.toMatchObject({ id: ready.id });

    for (const row of [...removed, ...removed]) await a.forget(row);
    await expect(a.deleting()).resolves.toEqual([]);
    const again = await a.reserve('doomed.bin', {
      objectId: crypto.randomUUID(),
      ownerPrincipalId: ownerA,
      sizeBytes: 1,
      contentType: null,
    });
    expect(again.kind).toBe('reserved');
  });

  // @story US-STO-04
  it('[US-STO-04][contract][sdk] a second workspace cannot remove, list deleting or forget the first one', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const b = catalog('b');
    await upload(a, ownerA, 'private.bin');
    const removed = await a.remove('private.bin');

    await expect(b.remove('private.bin')).resolves.toEqual([]);
    await expect(b.deleting()).resolves.toEqual([]);
    await expect(b.stalePending(new Date(Date.now() + 60_000))).resolves.toEqual([]);
    for (const row of removed) await b.forget(row);
    await expect(a.deleting()).resolves.toHaveLength(1);
  });
}
