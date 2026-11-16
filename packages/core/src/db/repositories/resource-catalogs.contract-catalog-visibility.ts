import { expect, it } from 'vitest';
import { paths } from './resource-catalogs.contract-catalog-fixtures.js';

import type { CatalogConformanceFixture } from './resource-catalogs.contract-fixture.js';
export function registerUploadVisibilityTests(
  makeFixture: () => Promise<CatalogConformanceFixture>,
): void {
  // @story US-STO-02
  it('[US-STO-02][contract][sdk] a reserved row is pending and invisible to get and list', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const reserved = await a.reserve('big.bin', {
      objectId: crypto.randomUUID(),
      ownerPrincipalId: ownerA,
      sizeBytes: 5,
      contentType: null,
    });
    expect(reserved).toMatchObject({
      kind: 'reserved',
      row: { path: 'big.bin', kind: 'file', status: 'pending', ownerPrincipalId: ownerA },
    });
    await expect(a.get('big.bin')).resolves.toBeNull();
    expect(paths((await a.list('')).rows)).not.toContain('big.bin');
  });

  // @story US-STO-02
  it('[US-STO-02][contract][sdk] new rows default to the files area with the reserved object id', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const reserved = await a.reserve('docs/big.bin', {
      objectId: crypto.randomUUID(),
      ownerPrincipalId: ownerA,
      sizeBytes: 5,
      contentType: null,
    });
    const defaults = { area: 'files', sha256: null };
    const { objectId } = reserved.row;
    expect(reserved.row).toMatchObject({ ...defaults, storageKey: `files/${String(objectId)}` });
    await expect(
      a.confirm(reserved.row, { sizeBytes: 5, contentType: null }),
    ).resolves.toMatchObject({ row: { ...defaults, objectId } });
    await expect(a.get('docs')).resolves.toMatchObject({
      kind: 'folder',
      ...defaults,
      objectId: null,
    });
  });

  // @story US-STO-02
  it('[US-STO-02][contract][sdk] two rows in one workspace never share an object id', async () => {
    const { seed } = await makeFixture();
    const objectId = crypto.randomUUID();
    await seed('a', { path: 'one.bin', status: 'ready', objectId });
    await expect(seed('a', { path: 'two.bin', status: 'ready', objectId })).rejects.toThrow();
    await expect(
      seed('b', { path: 'one.bin', status: 'ready', objectId }),
    ).resolves.toBeUndefined();
  });

  // @story US-STO-02
  it('[US-STO-02][contract][sdk] get with includePending returns a pending row', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const reserved = await a.reserve('big.bin', {
      objectId: crypto.randomUUID(),
      ownerPrincipalId: ownerA,
      sizeBytes: 5,
      contentType: null,
    });
    await expect(a.get('big.bin', { includePending: true })).resolves.toMatchObject({
      id: reserved.row.id,
      status: 'pending',
    });
    await expect(a.get('missing.bin', { includePending: true })).resolves.toBeNull();
  });

  // @story US-STO-02
  it('[US-STO-02][contract][sdk] confirm makes the row ready and listed', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const reserved = await a.reserve('big.bin', {
      objectId: crypto.randomUUID(),
      ownerPrincipalId: ownerA,
      sizeBytes: 5,
      contentType: null,
    });
    const confirmed = await a.confirm(reserved.row, {
      sizeBytes: 7,
      contentType: 'application/octet-stream',
      sha256: null,
    });
    expect(confirmed).toMatchObject({
      row: {
        id: reserved.row.id,
        status: 'ready',
        sizeBytes: 7,
        contentType: 'application/octet-stream',
      },
    });
    expect(confirmed?.replaced).toBeUndefined();
    await expect(a.get('big.bin')).resolves.toMatchObject({ id: reserved.row.id });
    expect(paths((await a.list('')).rows)).toContain('big.bin');
  });

  // @story US-STO-01
  it('[US-STO-01][contract][sdk] every returned row says when it was last written, and get and list agree', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const reserved = await a.reserve('dated/a.txt', {
      objectId: crypto.randomUUID(),
      ownerPrincipalId: ownerA,
      sizeBytes: 1,
      contentType: null,
    });
    expect(reserved.row.updatedAt).toBeInstanceOf(Date);
    const confirmed = await a.confirm(reserved.row, { sizeBytes: 1, contentType: 'text/plain' });
    const written = confirmed?.row.updatedAt;
    expect(written).toBeInstanceOf(Date);
    expect(written?.getTime()).toBeGreaterThanOrEqual(reserved.row.updatedAt?.getTime() ?? 0);
    expect((await a.get('dated/a.txt'))?.updatedAt).toEqual(written);
    const listed = (await a.list('')).rows;
    expect(listed.find((row) => row.path === 'dated/a.txt')?.updatedAt).toEqual(written);
    expect(listed.find((row) => row.path === 'dated')?.updatedAt).toBeInstanceOf(Date);
  });
}
