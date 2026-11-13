import { bytesToStream, storageObjectName } from '@agent-workspace/core/storage';
import { expect, it } from 'vitest';
import { type StorageContext } from '../storage/service';
import { bytesOf, createMoveDeleteFixture } from './move-delete.test-support';

export function registerOwnershipTests(fixture: ReturnType<typeof createMoveDeleteFixture>) {
  // @story US-STO-03
  // @story US-STO-04
  it('[US-STO-03][api][sdk] a member cannot move or delete another member’s file, and a viewer cannot at all', () =>
    usSTO03ApiSdkMemberCannotMove(fixture));

  // @story US-STO-04
  it('[US-STO-04][api][sdk] the uploader deletes its own pending upload, row and object', () =>
    usSTO04ApiSdkUploaderDeletesOwn(fixture));

  // @story US-STO-04
  it('[US-STO-04][api][sdk] another member’s pending upload is not the builder’s to delete, and a viewer deletes none', () =>
    usSTO04ApiSdkAnotherMemberS(fixture));

  // @story US-STO-03
  // @story US-STO-04
  it('[US-STO-04][api][sdk] owning a folder does not let a member move or delete another member’s file in it', () =>
    usSTO04ApiSdkOwningFolderDoes(fixture));
}

async function usSTO03ApiSdkMemberCannotMove(fixture: ReturnType<typeof createMoveDeleteFixture>) {
  const row = await fixture.save('docs/a.txt', 'alpha');
  const name = storageObjectName(fixture.world.a.workspaceId, 'files', row.objectId ?? '');
  fixture.calls.writes = 0;

  for (const actor of ['builder', 'viewer'] as const) {
    expect((await fixture.move('docs/a.txt', 'docs/b.txt', actor)).status).toBe(403);
    expect((await fixture.remove('docs/a.txt', { actor })).status).toBe(403);
    expect((await fixture.move('docs', 'elsewhere', actor)).status).toBe(403);
    expect((await fixture.remove('docs', { actor, recursive: true })).status).toBe(403);
  }

  expect(fixture.calls.writes).toBe(0);
  expect(await fixture.objects.head(name)).not.toBeNull();
  expect(await (await fixture.download('docs/a.txt')).text()).toBe('alpha');
}

async function usSTO04ApiSdkUploaderDeletesOwn(
  fixture: ReturnType<typeof createMoveDeleteFixture>,
) {
  const name = await fixture.pendingUpload(fixture.builderId, 'docs/in-flight.txt');
  const catalog = await fixture.world.catalogs.forWorkspace(fixture.world.a.workspaceId);

  const response = await fixture.remove('docs/in-flight.txt', { actor: 'builder' });

  expect(response.status, await response.clone().text()).toBe(204);
  expect(await catalog.pending('docs/in-flight.txt')).toBeNull();
  expect(await fixture.objects.head(name)).toBeNull();
}

async function usSTO04ApiSdkAnotherMemberS(fixture: ReturnType<typeof createMoveDeleteFixture>) {
  const name = await fixture.pendingUpload(fixture.world.a.principalId, 'docs/theirs.txt');
  const mine = await fixture.pendingUpload(fixture.builderId, 'docs/mine.txt');
  const catalog = await fixture.world.catalogs.forWorkspace(fixture.world.a.workspaceId);

  expect((await fixture.remove('docs/theirs.txt', { actor: 'builder' })).status).toBe(403);
  expect((await fixture.remove('docs/mine.txt', { actor: 'viewer' })).status).toBe(403);

  expect(await catalog.pending('docs/theirs.txt')).not.toBeNull();
  expect(await catalog.pending('docs/mine.txt')).not.toBeNull();
  expect(await fixture.objects.head(name)).not.toBeNull();
  expect(await fixture.objects.head(mine)).not.toBeNull();
}

async function usSTO04ApiSdkOwningFolderDoes(fixture: ReturnType<typeof createMoveDeleteFixture>) {
  const catalog = await fixture.world.catalogs.forWorkspace(fixture.world.a.workspaceId);
  const builder = { ...fixture.ctx(), principalId: fixture.builderId, userId: null };
  const saveAs = async (who: StorageContext, path: string, text: string) => {
    const saved = await fixture.storage.save(who, {
      area: 'files',
      path,
      maxBytes: 1024,
      replace: true,
      body: bytesToStream(bytesOf(text)),
    });
    if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
    return saved.row;
  };
  // The builder's folder, holding one file of the builder's and one of the owner's.
  await catalog.createFolder('shared', { ownerPrincipalId: fixture.builderId });
  await saveAs(builder, 'shared/mine.txt', 'mine');
  const theirs = await saveAs(fixture.ctx(), 'shared/theirs.txt', 'theirs');
  const name = storageObjectName(fixture.world.a.workspaceId, 'files', theirs.objectId ?? '');
  // A folder of the builder's own files only: the control that the builder may move its own.
  await catalog.createFolder('own', { ownerPrincipalId: fixture.builderId });
  await saveAs(builder, 'own/a.txt', 'a');
  fixture.calls.writes = 0;

  expect((await fixture.move('shared', 'elsewhere', 'builder')).status).toBe(403);
  expect((await fixture.remove('shared', { actor: 'builder', recursive: true })).status).toBe(403);
  expect((await fixture.move('own', 'moved-own', 'builder')).status).toBe(200);

  expect(fixture.calls.writes).toBe(0);
  expect(await fixture.objects.head(name)).not.toBeNull();
  expect(await (await fixture.download('shared/theirs.txt')).text()).toBe('theirs');
  expect(await (await fixture.download('shared/mine.txt')).text()).toBe('mine');
}
