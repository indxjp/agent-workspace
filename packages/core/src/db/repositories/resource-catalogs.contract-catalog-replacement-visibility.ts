import { expect, it } from 'vitest';
import { sidePath } from '../side-paths.js';
import { pending, replace, upload } from './resource-catalogs.contract-catalog-fixtures.js';
import { type CatalogFile } from './resource-catalogs.js';

import type { CatalogConformanceFixture } from './resource-catalogs.contract-fixture.js';
export function registerReplacementVisibilityTests(
  makeFixture: () => Promise<CatalogConformanceFixture>,
): void {
  // @story US-STO-14
  it('[US-STO-14][contract][sdk] referencing finds rows in every status by object id', async () => {
    const { catalog, ownerA, ownerB } = await makeFixture();
    const a = catalog('a');
    const ready = await upload(a, ownerA, 'ready.bin');
    await upload(a, ownerA, 'gone.bin');
    const [gone] = await a.remove('gone.bin');
    const stillPending = await pending(a, ownerA, 'pending.bin');
    const replacement = await replace(a, ownerA, 'ready.bin');
    if (replacement.kind !== 'reserved') throw new Error('the replacement was not reserved');
    expect(replacement.row.path).not.toBe('ready.bin');
    const elsewhere = await upload(catalog('b'), ownerB, 'ready.bin');
    const idsOf = (rows: readonly (CatalogFile | undefined)[]) =>
      rows.map((row) => row?.objectId ?? '');

    const found = await a.referencing({
      objectIds: [
        ...idsOf([ready, gone, stillPending, replacement.row, elsewhere]),
        crypto.randomUUID(),
      ],
    });

    expect(found.map((row) => row.id).sort()).toEqual(
      [ready.id, gone?.id, stillPending.id, replacement.row.id].sort(),
    );
    await expect(a.referencing({ objectIds: [] })).resolves.toEqual([]);
    await expect(catalog('b').referencing({ objectIds: idsOf([ready, gone]) })).resolves.toEqual(
      [],
    );
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] rename of a new-style row keeps its storage key and object id', async () => {
    const { catalog, seed } = await makeFixture();
    const a = catalog('a');
    const objectId = crypto.randomUUID();
    await seed('a', { path: 'old/new-style.bin', status: 'ready', objectId });
    const before = await a.get('old/new-style.bin');

    await expect(a.rename('old', 'moved')).resolves.toEqual({ rows: 1, files: 1 });
    await expect(a.get('moved/new-style.bin')).resolves.toMatchObject({
      id: before?.id,
      objectId,
      storageKey: before?.storageKey,
    });
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] confirming a replacement leaves exactly one ready row and marks the old one deleting', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const old = await upload(a, ownerA, 'r.bin', 1);
    const reserved = await replace(a, ownerA, 'r.bin');
    expect(reserved.kind).toBe('reserved');

    const done = await a.confirm(reserved.row, {
      sizeBytes: 2,
      contentType: 'text/plain',
      sha256: 'cd'.repeat(32),
    });
    expect(done).toMatchObject({
      row: {
        id: reserved.row.id,
        path: 'r.bin',
        status: 'ready',
        sizeBytes: 2,
        targetPath: null,
      },
      replaced: { id: old.id, status: 'deleting', targetPath: 'r.bin' },
    });
    expect((await a.list('')).rows.filter((row) => row.path === 'r.bin')).toEqual([done?.row]);
    await expect(a.deleting()).resolves.toEqual([done?.replaced]);
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] a replacement is pending beside the ready row; get and list still show the old row', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const old = await upload(a, ownerA, 'r.bin');
    const reserved = await replace(a, ownerA, 'r.bin');

    expect(reserved).toMatchObject({
      kind: 'reserved',
      row: { status: 'pending', targetPath: 'r.bin' },
    });
    expect(reserved.row.path).toBe(sidePath(reserved.row.id));
    await expect(a.get('r.bin')).resolves.toMatchObject({ id: old.id });
    await expect(a.get('r.bin', { includePending: true })).resolves.toMatchObject({ id: old.id });
    expect((await a.list('')).rows.map((row) => row.id)).toEqual([old.id]);
    await expect(a.countPending()).resolves.toBe(1);
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] a second pending replacement of one path is taken', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    await upload(a, ownerA, 'r.bin');
    const first = await replace(a, ownerA, 'r.bin');
    const second = await replace(a, ownerA, 'r.bin');
    expect(second).toMatchObject({ kind: 'taken', row: { id: first.row.id, status: 'pending' } });
    await expect(a.countPending()).resolves.toBe(1);
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] a reserve with an object id on a free path stores the object id and key', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const objectId = crypto.randomUUID();
    const reserved = await a.reserve('new/free.bin', {
      ownerPrincipalId: ownerA,
      sizeBytes: 1,
      contentType: null,
      objectId,
      area: 'files',
    });
    expect(reserved).toMatchObject({
      kind: 'reserved',
      row: { path: 'new/free.bin', objectId, area: 'files', storageKey: `files/${objectId}` },
    });
    expect(reserved.row.targetPath ?? null).toBeNull();
  });
}
