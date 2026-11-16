import { expect, it } from 'vitest';
import { upload } from './resource-catalogs.contract-catalog-fixtures.js';

import type { CatalogConformanceFixture } from './resource-catalogs.contract-fixture.js';
export function registerCatalogTenancyTests(
  makeFixture: () => Promise<CatalogConformanceFixture>,
): void {
  it('never shows workspace A to workspace B, and B can reserve the same path', async () => {
    const { catalog, ownerA, ownerB } = await makeFixture();
    const a = catalog('a');
    const b = catalog('b');
    const fileA = await upload(a, ownerA, 'shared/same.txt');
    const pendingA = await a.reserve('pending.bin', {
      objectId: crypto.randomUUID(),
      ownerPrincipalId: ownerA,
      sizeBytes: 1,
      contentType: null,
    });

    await expect(b.get('shared/same.txt')).resolves.toBeNull();
    await expect(b.get('pending.bin', { includePending: true })).resolves.toBeNull();
    expect((await b.list('')).rows).toEqual([]);
    await expect(b.confirm(pendingA.row, { sizeBytes: 1, contentType: null })).resolves.toBeNull();
    await expect(b.rename('shared', 'taken')).resolves.toEqual({ rows: 0, files: 0 });
    await expect(b.remove('shared')).resolves.toEqual([]);

    const reservedInB = await b.reserve('shared/same.txt', {
      objectId: crypto.randomUUID(),
      ownerPrincipalId: ownerB,
      sizeBytes: 2,
      contentType: null,
    });
    expect(reservedInB).toMatchObject({ kind: 'reserved', row: { ownerPrincipalId: ownerB } });
    expect(reservedInB.row.id).not.toBe(fileA.id);
    await expect(a.get('shared/same.txt')).resolves.toMatchObject({ id: fileA.id });
    await expect(a.get('pending.bin', { includePending: true })).resolves.toMatchObject({
      status: 'pending',
    });
  });
}
