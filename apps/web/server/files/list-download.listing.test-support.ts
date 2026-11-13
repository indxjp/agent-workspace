import { expect, it } from 'vitest';
import { seedCatalogFile } from '@agent-workspace/core/db';
import type { FileReadFixture } from './list-download.harness.test-support';

export function registerFileReadListingTests(
  getFixture: () => Pick<FileReadFixture, 'save' | 'listed' | 'download' | 'world'>,
) {
  // @story US-STO-01
  // @story US-STO-05
  it('[US-STO-01][api][sdk] a file saved under the new naming downloads and appears in the list', async () => {
    const testContext = getFixture();

    const row = await testContext.save('reports/q3.txt', 'quarter three');
    expect(row.objectId).not.toBeNull();

    const files = await testContext.listed('a', 'reports');
    expect(files).toEqual([
      expect.objectContaining({
        id: row.id,
        path: 'reports/q3.txt',
        kind: 'file',
        sizeBytes: 13,
      }),
    ]);

    const response = await testContext.download('a', 'reports/q3.txt');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('quarter three');

    expect((await testContext.download('b', 'reports/q3.txt')).status).toBe(404);
    expect(await testContext.listed('b', 'reports')).toEqual([]);
  });

  // @story US-STO-01
  it('[US-STO-01][api][sdk] list shows only ready files', async () => {
    const testContext1 = getFixture();

    await testContext1.save('docs/ready.txt', 'ready');
    await testContext1.save('docs/gone.txt', 'gone');
    const catalog = await testContext1.world.catalogs.forWorkspace(
      testContext1.world.a.workspaceId,
    );
    await catalog.remove('docs/gone.txt');
    await catalog.reserve('docs/pending.txt', {
      ownerPrincipalId: testContext1.world.a.principalId,
      sizeBytes: 3,
      contentType: null,
      objectId: crypto.randomUUID(),
      area: 'files',
    });

    expect((await testContext1.listed('a', 'docs')).map((file) => file.path)).toEqual([
      'docs/ready.txt',
    ]);
    expect((await testContext1.download('a', 'docs/pending.txt')).status).toBe(404);
    expect((await testContext1.download('a', 'docs/gone.txt')).status).toBe(404);
    expect(await testContext1.listed('b', 'docs')).toEqual([]);
    expect((await testContext1.download('b', 'docs/ready.txt')).status).toBe(404);
  });

  // @story US-STO-01
  it('[US-STO-01][api][sdk] list shows one level, with explicit and implied folders', async () => {
    const testContext2 = getFixture();

    await testContext2.save('docs/a.txt', 'a');
    await testContext2.save('docs/sub/b.txt', 'b');
    await testContext2.save('top.txt', 't');
    const catalog = await testContext2.world.catalogs.forWorkspace(
      testContext2.world.a.workspaceId,
    );
    await seedCatalogFile(catalog, {
      path: 'empty',
      kind: 'folder',
      sizeBytes: 0,
      contentType: null,
      ownerPrincipalId: testContext2.world.a.principalId,
    });

    const root = await testContext2.listed('a');
    expect(root.map((entry) => `${entry.kind}:${entry.path}`).sort()).toEqual([
      'file:top.txt',
      'folder:docs',
      'folder:empty',
    ]);
    const docs = await testContext2.listed('a', 'docs');
    expect(docs.map((entry) => `${entry.kind}:${entry.path}`).sort()).toEqual([
      'file:docs/a.txt',
      'folder:docs/sub',
    ]);
    expect(await testContext2.listed('b')).toEqual([]);
  });
}
