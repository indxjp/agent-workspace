import { expect, it } from 'vitest';
import {
  checkViolation,
  pending,
  replace,
  upload,
} from './resource-catalogs.contract-catalog-fixtures.js';
import { CatalogPathPendingError, CatalogPathTakenError } from './resource-catalogs.js';

import type { CatalogConformanceFixture } from './resource-catalogs.contract-fixture.js';
export function registerPendingWritesTests(
  makeFixture: () => Promise<CatalogConformanceFixture>,
): void {
  // @story US-STO-02
  it('[US-STO-02][contract][sdk] confirm of a forgotten row returns null', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const reserved = await a.reserve('big.bin', {
      objectId: crypto.randomUUID(),
      ownerPrincipalId: ownerA,
      sizeBytes: 5,
      contentType: null,
    });
    const [removed] = await a.remove('big.bin');
    expect(removed).toMatchObject({ id: reserved.row.id, status: 'deleting' });
    await expect(a.confirm(reserved.row, { sizeBytes: 5, contentType: null })).resolves.toBeNull();
    await expect(a.get('big.bin', { includePending: true })).resolves.toBeNull();
    if (removed !== undefined) await a.forget(removed);
    await expect(a.confirm(reserved.row, { sizeBytes: 5, contentType: null })).resolves.toBeNull();
  });

  // @story US-STO-02
  it('[US-STO-02][contract][sdk] confirm of a ready row returns null and changes nothing', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const ready = await upload(a, ownerA, 'done.txt', 4);
    await expect(a.confirm(ready, { sizeBytes: 9, contentType: 'image/png' })).resolves.toBeNull();
    await expect(a.get('done.txt')).resolves.toMatchObject({
      id: ready.id,
      sizeBytes: 4,
      contentType: 'text/plain',
    });
    await expect(
      a.confirm(ready, { sizeBytes: 9, contentType: 'image/png', expect: 'any' }),
    ).resolves.toMatchObject({ row: { id: ready.id, status: 'ready', sizeBytes: 9 } });
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] the owner re-reserves a pending path with a new size', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const row = await pending(a, ownerA, 'big.bin');
    await expect(
      a.reserve('big.bin', {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ownerA,
        sizeBytes: 9,
        contentType: 'text/csv',
      }),
    ).resolves.toMatchObject({
      kind: 'taken',
      row: { id: row.id, status: 'pending', sizeBytes: 9, contentType: 'text/csv' },
    });
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] another member cannot re-reserve a pending path', async () => {
    const { catalog, ownerA, ownerB } = await makeFixture();
    const a = catalog('a');
    const row = await pending(a, ownerA, 'big.bin');
    await expect(
      a.reserve('big.bin', {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ownerB,
        sizeBytes: 9,
        contentType: null,
      }),
    ).rejects.toBeInstanceOf(CatalogPathPendingError);
    await expect(a.get('big.bin', { includePending: true })).resolves.toEqual(row);
  });

  // @story US-STO-02
  it('[US-STO-02][contract][sdk] a folder move refuses while a child is pending', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const done = await upload(a, ownerA, 'docs/done.txt');
    const row = await pending(a, ownerA, 'docs/sub/x.bin');
    await expect(a.rename('docs', 'moved')).rejects.toBeInstanceOf(CatalogPathPendingError);
    await expect(a.get('docs/done.txt')).resolves.toMatchObject({ id: done.id });
    await expect(a.get('docs/sub/x.bin', { includePending: true })).resolves.toEqual(row);
    await expect(a.get('moved', { includePending: true })).resolves.toBeNull();
  });

  // @story US-STO-02
  it('[US-STO-02][contract][sdk] a move never carries a pending row: the row itself, a replacement, or the destination', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    // The pending row itself: an in-flight PUT still targets its key.
    const lone = await pending(a, ownerA, 'big.bin');
    await expect(a.rename('big.bin', 'moved.bin')).rejects.toBeInstanceOf(CatalogPathPendingError);
    await expect(a.get('big.bin', { includePending: true })).resolves.toEqual(lone);
    await expect(a.get('moved.bin', { includePending: true })).resolves.toBeNull();

    // A ready child whose replacement is pending at its side path.
    const ready = await upload(a, ownerA, 'docs/x.bin');
    const replacement = await replace(a, ownerA, 'docs/x.bin');
    if (replacement.kind !== 'reserved') throw new Error('docs/x.bin was not replaceable');
    await expect(a.rename('docs', 'moved')).rejects.toBeInstanceOf(CatalogPathPendingError);
    await expect(a.get('docs/x.bin')).resolves.toMatchObject({ id: ready.id });
    await expect(a.pending('docs/x.bin')).resolves.toMatchObject({ id: replacement.row.id });
    await expect(a.get('moved', { includePending: true })).resolves.toBeNull();

    // A destination held by a pending upload is taken, not overwritten.
    await a.forget(replacement.row);
    const target = await pending(a, ownerA, 'dest/x.bin');
    await expect(a.rename('docs', 'dest')).rejects.toBeInstanceOf(CatalogPathTakenError);
    await expect(a.get('dest/x.bin', { includePending: true })).resolves.toEqual(target);
    await expect(a.get('docs/x.bin')).resolves.toMatchObject({ id: ready.id });
  });

  it('refuses a dot segment in a path as the files_path_no_dot_segments CHECK does', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    await expect(
      a.reserve('docs/../x.bin', {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ownerA,
        sizeBytes: 1,
        contentType: null,
      }),
    ).rejects.toMatchObject(checkViolation('files_path_no_dot_segments'));
    await expect(a.get('docs', { includePending: true })).resolves.toBeNull();
  });

  it('refuses a negative size as the files_size_non_negative CHECK does', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    await expect(
      a.reserve('neg.bin', {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ownerA,
        sizeBytes: -1,
        contentType: null,
      }),
    ).rejects.toMatchObject(checkViolation('files_size_non_negative'));
    await expect(a.get('neg.bin', { includePending: true })).resolves.toBeNull();
  });

  // @story US-STO-02
  it('[US-STO-02][contract][sdk] rename refuses a pending row and leaves it in place', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    await a.reserve('big.bin', {
      objectId: crypto.randomUUID(),
      ownerPrincipalId: ownerA,
      sizeBytes: 5,
      contentType: null,
    });
    await expect(a.rename('big.bin', 'moved.bin')).rejects.toBeInstanceOf(CatalogPathPendingError);
    await expect(a.get('big.bin', { includePending: true })).resolves.toMatchObject({
      status: 'pending',
    });
    await expect(a.get('moved.bin', { includePending: true })).resolves.toBeNull();
  });
}
