import { expect, it } from 'vitest';
import { sidePath } from '../side-paths.js';
import { paths, pending, upload } from './resource-catalogs.contract-catalog-fixtures.js';

import type { CatalogConformanceFixture } from './resource-catalogs.contract-fixture.js';
export function registerCatalogTreeTests(
  makeFixture: () => Promise<CatalogConformanceFixture>,
): void {
  it('creates the parent folders of a reserved path, ready and owned by its owner', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    await a.reserve('docs/deep/big.bin', {
      objectId: crypto.randomUUID(),
      ownerPrincipalId: ownerA,
      sizeBytes: 5,
      contentType: null,
    });
    for (const path of ['docs', 'docs/deep']) {
      await expect(a.get(path)).resolves.toMatchObject({
        kind: 'folder',
        status: 'ready',
        ownerPrincipalId: ownerA,
      });
    }
  });

  it('[US-STO-01][contract][sdk] createFolder adds a ready folder row with its parents and no object', async () => {
    const { catalog, ownerA, actorA } = await makeFixture();
    const a = catalog('a');
    const made = await a.createFolder('docs/deep', {
      ownerPrincipalId: ownerA,
      createdBy: actorA,
    });
    expect(made).toMatchObject({
      kind: 'created',
      row: {
        path: 'docs/deep',
        kind: 'folder',
        status: 'ready',
        storageKey: null,
        sizeBytes: 0,
        ownerPrincipalId: ownerA,
        createdBy: actorA,
      },
    });
    await expect(a.get('docs')).resolves.toMatchObject({ kind: 'folder', status: 'ready' });
    expect(paths((await a.list('')).rows)).toEqual(['docs', 'docs/deep']);

    const again = await a.createFolder('docs/deep', { ownerPrincipalId: ownerA });
    expect(again).toMatchObject({ kind: 'taken', row: { id: made.row.id } });
  });

  it('[US-STO-01][contract][sdk] createFolder over a file or a pending upload is taken and changes nothing', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const file = await upload(a, ownerA, 'docs/ready.txt');
    const held = await pending(a, ownerA, 'docs/pending.txt');

    await expect(
      a.createFolder('docs/ready.txt', { ownerPrincipalId: ownerA }),
    ).resolves.toMatchObject({ kind: 'taken', row: { id: file.id, kind: 'file' } });
    await expect(
      a.createFolder('docs/pending.txt', { ownerPrincipalId: ownerA }),
    ).resolves.toMatchObject({ kind: 'taken', row: { id: held.id, status: 'pending' } });
    await expect(a.get('docs/ready.txt')).resolves.toMatchObject({ id: file.id, kind: 'file' });
    await expect(a.createFolder(sidePath(file.id), { ownerPrincipalId: ownerA })).rejects.toThrow(
      'reserved catalog path',
    );
  });

  it('lists ready rows in path order, a page at a time, and clamps the page size', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    for (const name of ['f3', 'f1', 'f5', 'f2', 'f4']) await upload(a, ownerA, name);
    await a.reserve('f0', {
      objectId: crypto.randomUUID(),
      ownerPrincipalId: ownerA,
      sizeBytes: 1,
      contentType: null,
    });

    const first = await a.list('', { limit: 2 });
    expect(paths(first.rows)).toEqual(['f1', 'f2']);
    expect(first.cursor).toBe('f2');
    const second = await a.list('', { cursor: 'f2', limit: 2 });
    expect(paths(second.rows)).toEqual(['f3', 'f4']);
    expect(second.cursor).toBe('f4');
    const last = await a.list('', { cursor: 'f4', limit: 2 });
    expect(paths(last.rows)).toEqual(['f5']);
    expect(last.cursor).toBeNull();

    expect(paths((await a.list('', { limit: 0 })).rows)).toEqual(['f1']);
    expect(paths((await a.list('', { limit: 100_000 })).rows)).toHaveLength(5);
  });

  it('pages in code-point order, as collate "C" does, not UTF-16 code-unit order', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    await upload(a, ownerA, 'a\u{1F600}');
    await upload(a, ownerA, 'a\u{FF01}');
    const first = await a.list('', { limit: 1 });
    expect(paths(first.rows)).toEqual(['a\u{FF01}']);
    expect(first.cursor).toBe('a\u{FF01}');
    const second = await a.list('', { cursor: 'a\u{FF01}', limit: 1 });
    expect(paths(second.rows)).toEqual(['a\u{1F600}']);
  });

  it('lists only what is at or under the folder, never a sibling that shares its characters', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    await upload(a, ownerA, 'docs/a.txt');
    await upload(a, ownerA, 'docs2/b.txt');
    expect(paths((await a.list('docs')).rows)).toEqual(['docs', 'docs/a.txt']);
  });

  it('renames a subtree keeping ids and leaves docs2 alone when renaming docs', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const inside = await upload(a, ownerA, 'docs/sub/a.txt');
    const sibling = await upload(a, ownerA, 'docs2/b.txt');

    // docs, docs/sub and docs/sub/a.txt: three rows, one of them a file
    await expect(a.rename('docs', 'guides')).resolves.toEqual({ rows: 3, files: 1 });

    await expect(a.get('guides/sub/a.txt')).resolves.toMatchObject({
      id: inside.id,
      storageKey: inside.storageKey,
    });
    await expect(a.get('docs/sub/a.txt')).resolves.toBeNull();
    await expect(a.get('docs2/b.txt')).resolves.toMatchObject({ id: sibling.id });
    await expect(a.rename('nothing-here', 'elsewhere')).resolves.toEqual({ rows: 0, files: 0 });
  });

  it('rename writes the parent folders of the target', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const file = await upload(a, ownerA, 'plain.txt');
    await expect(a.rename('plain.txt', 'new/place/plain.txt')).resolves.toEqual({
      rows: 1,
      files: 1,
    });
    await expect(a.get('new/place')).resolves.toMatchObject({ kind: 'folder' });
    await expect(a.get('new/place/plain.txt')).resolves.toMatchObject({ id: file.id });
  });
}
