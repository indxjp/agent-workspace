import { storageObjectName } from '@agent-workspace/core/storage';
import { expect, it } from 'vitest';
import { createMoveDeleteFixture } from './move-delete.test-support';

export function registerDeleteTests(fixture: ReturnType<typeof createMoveDeleteFixture>) {
  // @story US-STO-04
  it('[US-STO-04][api][sdk] delete removes the stored object', async () => {
    const row = await fixture.save('docs/a.txt', 'alpha');
    if (row.objectId === null || row.objectId === undefined) throw new Error('no object id');
    const name = storageObjectName(fixture.world.a.workspaceId, 'files', row.objectId);
    expect(await fixture.objects.head(name)).not.toBeNull();

    const response = await fixture.remove('docs/a.txt');

    expect(response.status).toBe(204);
    expect(await fixture.objects.head(name)).toBeNull();
    expect((await fixture.download('docs/a.txt')).status).toBe(404);
    const catalog = await fixture.world.catalogs.forWorkspace(fixture.world.a.workspaceId);
    expect(await catalog.get('docs/a.txt')).toBeNull();
  });

  // @story US-STO-04
  it('[US-STO-04][api][sdk] a folder with files needs recursive, and recursive removes every object', async () => {
    const first = await fixture.save('docs/a.txt', 'alpha');
    const second = await fixture.save('docs/sub/b.txt', 'beta');
    const names = [first, second].map((row) =>
      storageObjectName(fixture.world.a.workspaceId, 'files', row.objectId ?? ''),
    );

    const refused = await fixture.remove('docs');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: 'folder_not_empty' } });
    for (const name of names) expect(await fixture.objects.head(name)).not.toBeNull();

    const response = await fixture.remove('docs', { recursive: true });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      deleted: ['docs/a.txt', 'docs/sub/b.txt'],
    });
    for (const name of names) expect(await fixture.objects.head(name)).toBeNull();
    expect((await fixture.download('docs/a.txt')).status).toBe(404);
  });

  // @story US-STO-04
  it('[US-STO-04][api][sdk] a recursive delete names a file saved under the folder while it ran', async () => {
    await fixture.save('docs/a.txt', 'alpha');
    fixture.hooks.beforeRemove = async () => {
      fixture.hooks.beforeRemove = () => Promise.resolve();
      await fixture.save('docs/late.txt', 'late');
    };

    const response = await fixture.remove('docs', { recursive: true });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      deleted: ['docs/a.txt', 'docs/late.txt'],
    });
    expect((await fixture.download('docs/late.txt')).status).toBe(404);
  });

  // @story US-STO-04
  it('[US-STO-04][api][sdk] an empty folder deletes without recursive', async () => {
    const catalog = await fixture.world.catalogs.forWorkspace(fixture.world.a.workspaceId);
    await catalog.createFolder('empty', { ownerPrincipalId: fixture.world.a.principalId });

    const response = await fixture.remove('empty');

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', deleted: [] });
    expect(await catalog.get('empty')).toBeNull();
  });

  // @story US-STO-04
  it('[US-STO-04][api][sdk] deleting a path that is not there answers 204', async () => {
    expect((await fixture.remove('docs/missing.txt')).status).toBe(204);
  });
}
