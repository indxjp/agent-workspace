import { expect, it } from 'vitest';
import { listCatalogFiles } from '@agent-workspace/core/db';
import type { FileUploadFixture } from './upload-route.harness.test-support';
import { bytesOf, sha256Of } from './upload-route.fixture.test-support';
export function registerFileUploadAuthorizationTests(
  getFixture: () => Pick<
    FileUploadFixture,
    'post' | 'postFolder' | 'filesObjects' | 'catalogA' | 'world'
  >,
) {
  // @story US-STO-01
  it.each([
    ['../x', 'invalid_path'],
    ['%aside/x', 'invalid_path'],
    ['.claude/x', 'reserved_path'],
  ])(
    '[US-STO-01][api][sdk] the path %j is refused with %s and nothing is written',
    async (path, code) => {
      const testContext = getFixture();

      const response = await testContext.post(path, bytesOf('x'));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code } });
      const folder = await testContext.postFolder(path);
      expect(folder.status).toBe(400);
      expect((await testContext.post(path, bytesOf('x'), 'v')).status).toBe(403);
      expect(await testContext.filesObjects()).toEqual([]);
      expect(await listCatalogFiles(await testContext.catalogA())).toEqual([]);
    },
  );

  // @story US-STO-01
  it('[US-STO-01][api][sdk] a workspace B member cannot see or replace workspace A rows through its own upload', async () => {
    const testContext1 = getFixture();

    expect((await testContext1.post('shared.txt', bytesOf('a side'))).status).toBe(201);
    expect((await testContext1.post('shared.txt', bytesOf('b side'), 'b')).status).toBe(201);
    expect(await (await testContext1.catalogA()).get('shared.txt')).toMatchObject({
      sha256: sha256Of(bytesOf('a side')),
    });
    expect(
      await (
        await testContext1.world.catalogs.forWorkspace(testContext1.world.b.workspaceId)
      ).get('shared.txt'),
    ).toMatchObject({ sha256: sha256Of(bytesOf('b side')) });
  });
}
