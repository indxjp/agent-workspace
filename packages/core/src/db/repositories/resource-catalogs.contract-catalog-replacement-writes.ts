import { expect, it } from 'vitest';
import { sidePath } from '../side-paths.js';
import { replace, upload } from './resource-catalogs.contract-catalog-fixtures.js';
import { CatalogPathPendingError, CatalogPathTakenError } from './resource-catalogs.js';

import type { CatalogConformanceFixture } from './resource-catalogs.contract-fixture.js';
export function registerReplacementWritesTests(
  makeFixture: () => Promise<CatalogConformanceFixture>,
): void {
  // @story US-STO-02
  it('[US-STO-02][contract][sdk] confirm with an object id publishes that object and keeps the row id', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const ingress = crypto.randomUUID();
    const published = crypto.randomUUID();
    const input = { ownerPrincipalId: ownerA, sizeBytes: 1, contentType: null };
    const reserved = await a.reserve('up.bin', { ...input, objectId: ingress });
    const used = crypto.randomUUID();
    await a.reserve('other.bin', { ...input, objectId: used });

    await expect(
      a.confirm(reserved.row, { sizeBytes: 1, contentType: null, objectId: used }),
    ).rejects.toThrow();
    const done = await a.confirm(reserved.row, {
      sizeBytes: 1,
      contentType: null,
      objectId: published,
    });
    expect(done?.row).toMatchObject({
      id: reserved.row.id,
      status: 'ready',
      objectId: published,
      storageKey: `files/${published}`,
    });
    await expect(a.get('up.bin')).resolves.toMatchObject({ objectId: published });
    await expect(a.referencing({ objectIds: [ingress] })).resolves.toEqual([]);
    // The reservation's snapshot names the ingress object, so it confirms nothing again.
    await expect(
      a.confirm(reserved.row, { sizeBytes: 1, contentType: null, objectId: ingress }),
    ).resolves.toBeNull();
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] a reserve with an object id already in use is refused', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const objectId = crypto.randomUUID();
    const input = { ownerPrincipalId: ownerA, sizeBytes: 1, contentType: null, objectId };
    await a.reserve('used.bin', input);
    await upload(a, ownerA, 'r.bin');
    for (const path of ['free.bin', 'r.bin']) {
      await expect(a.reserve(path, input)).rejects.toThrow('files_workspace_object_key');
    }
    await expect(a.countPending()).resolves.toBe(1);
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] confirm of a forgotten replacement returns null and keeps the ready row', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const old = await upload(a, ownerA, 'r.bin');
    const reserved = await replace(a, ownerA, 'r.bin');
    await a.forget(reserved.row);

    await expect(a.confirm(reserved.row, { sizeBytes: 2, contentType: null })).resolves.toBeNull();
    await expect(a.get('r.bin')).resolves.toMatchObject({ id: old.id, status: 'ready' });
    await expect(a.deleting()).resolves.toEqual([]);
    expect((await replace(a, ownerA, 'r.bin')).kind).toBe('reserved');
  });

  // @story US-STO-04
  it('[US-STO-04][contract][sdk] removing a file also marks its pending replacement deleting', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const old = await upload(a, ownerA, 'r.bin');
    const reserved = await replace(a, ownerA, 'r.bin');

    const removed = await a.remove('r.bin');
    expect(removed.map((row) => row.id).sort()).toEqual([old.id, reserved.row.id].sort());
    expect(removed.every((row) => row.status === 'deleting' && row.targetPath === 'r.bin')).toBe(
      true,
    );
    await expect(a.get('r.bin', { includePending: true })).resolves.toBeNull();
    await expect(a.countPending()).resolves.toBe(0);
    await expect(a.confirm(reserved.row, { sizeBytes: 2, contentType: null })).resolves.toBeNull();
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] a folder move refuses while a file under it has a pending replacement', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const old = await upload(a, ownerA, 'docs/r.bin');
    const reserved = await replace(a, ownerA, 'docs/r.bin');

    await expect(a.rename('docs', 'guides')).rejects.toBeInstanceOf(CatalogPathPendingError);
    await expect(a.get('docs/r.bin')).resolves.toMatchObject({ id: old.id });
    await expect(a.get('guides/r.bin')).resolves.toBeNull();
    const done = await a.confirm(reserved.row, { sizeBytes: 2, contentType: null });
    expect(done).toMatchObject({
      row: { id: reserved.row.id, path: 'docs/r.bin', status: 'ready' },
      replaced: { id: old.id, targetPath: 'docs/r.bin' },
    });
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] rename onto a taken logical path is refused and moves nothing', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const from = await upload(a, ownerA, 'from.bin');
    const to = await upload(a, ownerA, 'to.bin');

    await expect(a.rename('from.bin', 'to.bin')).rejects.toBeInstanceOf(CatalogPathTakenError);
    await expect(a.get('from.bin')).resolves.toMatchObject({ id: from.id });
    await expect(a.get('to.bin')).resolves.toMatchObject({ id: to.id });
    await expect(a.rename('from.bin', 'to.bin')).rejects.toBeInstanceOf(CatalogPathTakenError);
    await expect(a.get('from.bin')).resolves.toMatchObject({ id: from.id });
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] a side path is never returned by get or list and cannot be written', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    await upload(a, ownerA, 'r.bin');
    const reserved = await replace(a, ownerA, 'r.bin');

    await expect(a.get(reserved.row.path)).resolves.toBeNull();
    await expect(a.get(reserved.row.path, { includePending: true })).resolves.toBeNull();
    expect((await a.list('')).rows.every((row) => row.path !== reserved.row.path)).toBe(true);
    await expect(
      a.reserve(sidePath(crypto.randomUUID()), {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ownerA,
        sizeBytes: 1,
        contentType: null,
      }),
    ).rejects.toThrow();
    await expect(a.rename('r.bin', sidePath(crypto.randomUUID()))).rejects.toThrow();
  });
}
