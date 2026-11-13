import { expect, it } from 'vitest';
import { pending, signed, upload } from './resource-catalogs.contract-catalog-fixtures.js';

import type { CatalogConformanceFixture } from './resource-catalogs.contract-fixture.js';
export function registerReservationTokensTests(
  makeFixture: () => Promise<CatalogConformanceFixture>,
): void {
  // @story US-STO-14
  it('[US-STO-14][contract][sdk] a re-mint of the same size makes the earlier snapshot stale for confirm and forget', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const objectId = crypto.randomUUID();
    const first = await signed(a, ownerA, 'mint.bin', objectId);
    const again = await signed(a, ownerA, 'mint.bin', objectId);
    expect(again).toMatchObject({ kind: 'taken', row: { id: first.row.id } });
    expect(first.row.reservationToken).toEqual(expect.any(String));
    expect(again.row.reservationToken).toEqual(expect.any(String));
    expect(again.row.reservationToken).not.toBe(first.row.reservationToken);

    await expect(a.confirm(first.row, { sizeBytes: 5, contentType: null })).resolves.toBeNull();
    await a.forget(first.row);
    await expect(a.pending('mint.bin')).resolves.toMatchObject({
      id: first.row.id,
      reservationToken: again.row.reservationToken,
    });
    await expect(a.confirm(again.row, { sizeBytes: 5, contentType: null })).resolves.toMatchObject({
      row: { id: first.row.id, status: 'ready' },
    });
  });

  // @story US-STO-04
  it('[US-STO-04][contract][sdk] remove with a pending snapshot claims only that unchanged reservation', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const objectId = crypto.randomUUID();
    const first = await signed(a, ownerA, 'claim.bin', objectId);
    const again = await signed(a, ownerA, 'claim.bin', objectId);

    await expect(a.remove('claim.bin', { pending: first.row })).resolves.toEqual([]);
    await expect(a.pending('claim.bin')).resolves.toMatchObject({ id: first.row.id });

    const claimed = await a.remove('claim.bin', { pending: again.row });
    expect(claimed).toMatchObject([
      { id: first.row.id, status: 'deleting', targetPath: 'claim.bin', reservationToken: null },
    ]);
    await expect(a.pending('claim.bin')).resolves.toBeNull();
    await expect(a.confirm(again.row, { sizeBytes: 5, contentType: null })).resolves.toBeNull();
    for (const row of claimed) await a.forget(row);
    await expect(a.deleting()).resolves.toEqual([]);
  });

  // @story US-STO-04
  it('[US-STO-04][contract][sdk] remove with a pending snapshot never claims a ready file or another path', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const reserved = await signed(a, ownerA, 'done.bin', crypto.randomUUID());
    const other = await pending(a, ownerA, 'other.bin');
    await a.confirm(reserved.row, { sizeBytes: 5, contentType: null });

    await expect(a.remove('done.bin', { pending: reserved.row })).resolves.toEqual([]);
    await expect(a.remove('done.bin', { pending: other })).resolves.toEqual([]);
    await expect(a.get('done.bin')).resolves.toMatchObject({ id: reserved.row.id });
    await expect(a.pending('other.bin')).resolves.toMatchObject({ id: other.id });
    await expect(a.deleting()).resolves.toEqual([]);
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] a duplicate relay reserve is refused without refreshing the winner', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const input = {
      ownerPrincipalId: ownerA,
      sizeBytes: 0,
      contentType: null,
      uploadMode: 'relay',
    } as const;
    const first = await a.reserve('relay.bin', { ...input, objectId: crypto.randomUUID() });
    const again = await a.reserve('relay.bin', { ...input, objectId: crypto.randomUUID() });

    expect(again).toMatchObject({ kind: 'taken', row: { id: first.row.id } });
    expect(first.row.reservationToken).toEqual(expect.any(String));
    expect(again.row.reservationToken).toBe(first.row.reservationToken);
    await expect(a.confirm(first.row, { sizeBytes: 3, contentType: null })).resolves.toMatchObject({
      row: { status: 'ready', sizeBytes: 3 },
    });
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] an unchanged retry without an upload mode keeps the snapshot; a changed one does not', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const input = {
      ownerPrincipalId: ownerA,
      sizeBytes: 5,
      contentType: null,
      objectId: crypto.randomUUID(),
    };
    const first = await a.reserve('retried.bin', input);
    const same = await a.reserve('retried.bin', input);
    expect(same.row.reservationToken).toBe(first.row.reservationToken);

    const resized = await a.reserve('retried.bin', { ...input, sizeBytes: 6 });
    expect(resized.row.reservationToken).not.toBe(first.row.reservationToken);
    await expect(a.confirm(first.row, { sizeBytes: 5, contentType: null })).resolves.toBeNull();
    await expect(
      a.confirm(resized.row, { sizeBytes: 6, contentType: null }),
    ).resolves.toMatchObject({ row: { status: 'ready' } });
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] a ready or removed row carries no reservation token', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const ready = await upload(a, ownerA, 'ready.bin');
    expect(ready.reservationToken ?? null).toBeNull();
    // Re-confirming a ready row with `expect: 'any'` still goes by id and key, not a spent token.
    await expect(
      a.confirm(ready, { sizeBytes: 2, contentType: null, expect: 'any' }),
    ).resolves.toMatchObject({ row: { id: ready.id, sizeBytes: 2 } });
    const [removed] = await a.remove('ready.bin');
    expect(removed?.reservationToken ?? null).toBeNull();
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] a replacement reserve names the ready file it replaces; a fresh one names none', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const old = await upload(a, ownerA, 'swap.bin');
    const objectId = crypto.randomUUID();

    const first = await signed(a, ownerA, 'swap.bin', objectId);
    expect(first).toMatchObject({
      kind: 'reserved',
      row: { targetPath: 'swap.bin' },
      replaces: { id: old.id, ownerPrincipalId: ownerA, status: 'ready' },
    });
    const again = await signed(a, ownerA, 'swap.bin', objectId);
    expect(again).toMatchObject({ kind: 'taken', replaces: { id: old.id } });

    const fresh = await signed(a, ownerA, 'new.bin', crypto.randomUUID());
    expect(fresh.kind).toBe('reserved');
    expect(fresh.replaces).toBeUndefined();
  });
}
