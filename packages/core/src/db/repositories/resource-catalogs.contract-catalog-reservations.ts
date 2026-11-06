import { expect, it } from 'vitest';
import { paths, pending, replace } from './resource-catalogs.contract-catalog-fixtures.js';
import { CatalogPathPendingError, type CatalogPort } from './resource-catalogs.js';

import type { CatalogConformanceFixture } from './resource-catalogs.contract-fixture.js';
export function registerUploadReservationsTests(
  makeFixture: () => Promise<CatalogConformanceFixture>,
): void {
  // @story US-STO-02
  it('[US-STO-02][contract][sdk] pending finds the upload for a path, a pending replacement included', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    await expect(a.pending('x.bin')).resolves.toBeNull();

    const fresh = await pending(a, ownerA, 'x.bin');
    await expect(a.pending('x.bin')).resolves.toMatchObject({ id: fresh.id });
    await a.confirm(fresh, { sizeBytes: 5, contentType: null });
    await expect(a.pending('x.bin')).resolves.toBeNull();

    const replacement = await replace(a, ownerA, 'x.bin');
    if (replacement.kind !== 'reserved') throw new Error('x.bin was not replaceable');
    await expect(a.get('x.bin', { includePending: true })).resolves.not.toMatchObject({
      id: replacement.row.id,
    });
    await expect(a.pending('x.bin')).resolves.toMatchObject({ id: replacement.row.id });
    await expect(catalog('b').pending('x.bin')).resolves.toBeNull();

    await a.forget(replacement.row);
    await expect(a.pending('x.bin')).resolves.toBeNull();
  });

  // @story US-STO-02
  it('[US-STO-02][contract][sdk] countPending counts pending rows of one workspace', async () => {
    const { catalog, ownerA, ownerB } = await makeFixture();
    const a = catalog('a');
    const b = catalog('b');
    const reserve = (target: CatalogPort, owner: string, path: string) =>
      target.reserve(path, {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: owner,
        sizeBytes: 1,
        contentType: null,
      });
    const x = await reserve(a, ownerA, 'x.bin');
    await reserve(a, ownerA, 'y.bin');
    await reserve(b, ownerB, 'z.bin');
    await expect(a.countPending()).resolves.toBe(2);
    await expect(b.countPending()).resolves.toBe(1);

    await a.confirm(x.row, { sizeBytes: 1, contentType: null });
    await expect(a.countPending()).resolves.toBe(1);
    await reserve(a, ownerA, 'y.bin');
    await expect(a.countPending()).resolves.toBe(1);

    await a.remove('y.bin');
    await expect(a.countPending()).resolves.toBe(0);
    await expect(b.countPending()).resolves.toBe(1);

    await a.reserve('.staging-s', {
      area: 'staging',
      objectId: crypto.randomUUID(),
      ownerPrincipalId: ownerA,
      sizeBytes: 0,
      contentType: null,
    });
    await expect(a.countPending()).resolves.toBe(0);
  });

  // @story US-STO-02
  it('[US-STO-02][contract][sdk] countPending with a cut-off counts only reservations made at or after it', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    await pending(a, ownerA, 'one.bin');
    await pending(a, ownerA, 'two.bin');
    const minute = 60_000;

    await expect(a.countPending(new Date(Date.now() - minute))).resolves.toBe(2);
    await expect(a.countPending(new Date(Date.now() + minute))).resolves.toBe(0);
    await expect(a.countPending()).resolves.toBe(2);
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] one row per path', async () => {
    const { catalog, ownerA, ownerB } = await makeFixture();
    const a = catalog('a');
    const first = await a.reserve('big.bin', {
      objectId: crypto.randomUUID(),
      ownerPrincipalId: ownerA,
      sizeBytes: 5,
      contentType: null,
    });
    await expect(
      a.reserve('big.bin', {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ownerB,
        sizeBytes: 9,
        contentType: 'text/plain',
      }),
    ).rejects.toBeInstanceOf(CatalogPathPendingError);
    await expect(a.get('big.bin')).resolves.toBeNull();
    await a.confirm(first.row, { sizeBytes: 5, contentType: null });
    const third = await a.reserve('big.bin', {
      objectId: crypto.randomUUID(),
      ownerPrincipalId: ownerA,
      sizeBytes: 9,
      contentType: null,
    });
    // A reserve over a ready file waits aside to replace it.
    expect(third).toMatchObject({
      kind: 'reserved',
      row: { targetPath: 'big.bin', status: 'pending' },
      replaces: { id: first.row.id, ownerPrincipalId: ownerA, status: 'ready' },
    });
    expect(paths((await a.list('')).rows).filter((path) => path === 'big.bin')).toHaveLength(1);
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] a pending row is refreshed only by a reserve of its own upload mode', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const input = { ownerPrincipalId: ownerA, contentType: null };
    // (a) a relay save over the owner's pending signed upload must not reset its declared size.
    const signed = await a.reserve('signed.bin', {
      objectId: crypto.randomUUID(),
      ...input,
      sizeBytes: 9,
      uploadMode: 'signed',
    });
    await expect(
      a.reserve('signed.bin', {
        objectId: crypto.randomUUID(),
        ...input,
        sizeBytes: 0,
        uploadMode: 'relay',
      }),
    ).rejects.toBeInstanceOf(CatalogPathPendingError);
    await expect(
      a.reserve('signed.bin', { objectId: crypto.randomUUID(), ...input, sizeBytes: 0 }),
    ).rejects.toBeInstanceOf(CatalogPathPendingError);
    await expect(
      a.reserve('signed.bin', {
        objectId: crypto.randomUUID(),
        ...input,
        sizeBytes: 9,
        uploadMode: 'signed',
      }),
    ).resolves.toMatchObject({ kind: 'taken', row: { id: signed.row.id, sizeBytes: 9 } });
    await expect(a.pending('signed.bin')).resolves.toMatchObject({ sizeBytes: 9 });
    // (b) a mint during the owner's in-flight relay save must not take over the save's row.
    const relay = await a.reserve('relay.bin', {
      objectId: crypto.randomUUID(),
      ...input,
      sizeBytes: 0,
      uploadMode: 'relay',
    });
    await expect(
      a.reserve('relay.bin', {
        objectId: crypto.randomUUID(),
        ...input,
        sizeBytes: 5,
        uploadMode: 'signed',
      }),
    ).rejects.toBeInstanceOf(CatalogPathPendingError);
    await expect(a.pending('relay.bin')).resolves.toMatchObject({
      id: relay.row.id,
      sizeBytes: 0,
    });
  });
}
