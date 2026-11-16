import { MoveFileResponseSchema } from '@indx-workspace/contracts/files';
import { expect, it } from 'vitest';
import { createMoveDeleteFixture, FOLDER_FILES } from './move-delete.test-support';

export function registerRenameTests(fixture: ReturnType<typeof createMoveDeleteFixture>) {
  // @story US-STO-03
  it(
    '[US-STO-03][api][sdk] moving a folder copies no files',
    () => usSTO03ApiSdkMovingFolderCopies(fixture),
    180_000,
  );

  // @story US-STO-03
  it('[US-STO-03][api][sdk] renaming a file keeps its row and copies nothing', () =>
    usSTO03ApiSdkRenamingFileKeeps(fixture));

  // @story US-STO-03
  it('[US-STO-03][api][sdk] a rename onto an existing file answers name_conflict', () =>
    usSTO03ApiSdkRenameOntoExisting(fixture));

  // @story US-STO-03
  it('[US-STO-03][api][sdk] a rename of a missing path answers file_not_found', () =>
    usSTO03ApiSdkRenameMissingPath(fixture));

  // @story US-STO-03
  it('[US-STO-03][api][sdk] a rename onto a pending upload answers upload_in_progress', () =>
    usSTO03ApiSdkRenameOntoPending(fixture));

  // @story US-STO-03
  it('[US-STO-03][api][sdk] an unsafe destination answers invalid_path', () =>
    usSTO03ApiSdkUnsafeDestinationAnswers(fixture));

  // @story US-STO-03
  it('[US-STO-03][api][sdk] a folder cannot move into itself', () =>
    usSTO03ApiSdkFolderCannotMove(fixture));

  // @story US-STO-03
  it('[US-STO-03][api][sdk] a rename onto the same path is a no-op', () =>
    usSTO03ApiSdkRenameOntoSame(fixture));
}

async function usSTO03ApiSdkMovingFolderCopies(
  fixture: ReturnType<typeof createMoveDeleteFixture>,
) {
  await fixture.save('big/keep.txt', 'kept');
  await fixture.seedRows('big', FOLDER_FILES - 1);
  fixture.calls.writes = 0;

  const response = await fixture.move('big', 'archive/big');

  expect(response.status, await response.clone().text()).toBe(200);
  // The folder row moves with its files, and `moved` counts the files only.
  expect(await response.json()).toEqual({ status: 'ok', moved: FOLDER_FILES });
  expect(fixture.calls.writes).toBe(0);
  const moved = await fixture.download('archive/big/keep.txt');
  expect(moved.status).toBe(200);
  expect(await moved.text()).toBe('kept');
  expect((await fixture.download('big/keep.txt')).status).toBe(404);
}

async function usSTO03ApiSdkRenamingFileKeeps(fixture: ReturnType<typeof createMoveDeleteFixture>) {
  const row = await fixture.save('docs/a.txt', 'alpha');
  fixture.calls.writes = 0;

  const response = await fixture.move('docs/a.txt', 'docs/b.txt');

  expect(response.status, await response.clone().text()).toBe(200);
  const body = MoveFileResponseSchema.parse(await response.json());
  expect(body).toMatchObject({ file: { id: row.id, path: 'docs/b.txt', kind: 'file' } });
  expect(fixture.calls.writes).toBe(0);
  expect(await (await fixture.download('docs/b.txt')).text()).toBe('alpha');
  expect((await fixture.download('docs/a.txt')).status).toBe(404);
}

async function usSTO03ApiSdkRenameOntoExisting(
  fixture: ReturnType<typeof createMoveDeleteFixture>,
) {
  await fixture.save('docs/a.txt', 'alpha');
  await fixture.save('docs/b.txt', 'beta');

  const response = await fixture.move('docs/a.txt', 'docs/b.txt');

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'name_conflict' } });
  expect(await (await fixture.download('docs/a.txt')).text()).toBe('alpha');
  expect(await (await fixture.download('docs/b.txt')).text()).toBe('beta');
}

async function usSTO03ApiSdkRenameMissingPath(fixture: ReturnType<typeof createMoveDeleteFixture>) {
  const response = await fixture.move('docs/missing.txt', 'docs/b.txt');

  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: { code: 'file_not_found' } });
}

async function usSTO03ApiSdkRenameOntoPending(fixture: ReturnType<typeof createMoveDeleteFixture>) {
  await fixture.save('docs/a.txt', 'alpha');
  const catalog = await fixture.world.catalogs.forWorkspace(fixture.world.a.workspaceId);
  await catalog.reserve('docs/pending.txt', {
    ownerPrincipalId: fixture.world.a.principalId,
    sizeBytes: 1,
    contentType: null,
    objectId: crypto.randomUUID(),
    area: 'files',
  });

  const response = await fixture.move('docs/a.txt', 'docs/pending.txt');

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'upload_in_progress' } });
  expect((await fixture.download('docs/a.txt')).status).toBe(200);
}

async function usSTO03ApiSdkUnsafeDestinationAnswers(
  fixture: ReturnType<typeof createMoveDeleteFixture>,
) {
  await fixture.save('docs/a.txt', 'alpha');

  const response = await fixture.move('docs/a.txt', 'docs/../../escape.txt');

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'invalid_path' } });
  expect((await fixture.download('docs/a.txt')).status).toBe(200);
}

async function usSTO03ApiSdkFolderCannotMove(fixture: ReturnType<typeof createMoveDeleteFixture>) {
  await fixture.save('docs/a.txt', 'alpha');

  const response = await fixture.move('docs', 'docs/inner');

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'self_descendant' } });
  expect((await fixture.download('docs/a.txt')).status).toBe(200);
}

async function usSTO03ApiSdkRenameOntoSame(fixture: ReturnType<typeof createMoveDeleteFixture>) {
  const row = await fixture.save('docs/a.txt', 'alpha');
  fixture.calls.writes = 0;

  const file = await fixture.move('docs/a.txt', 'docs/a.txt');
  expect(file.status, await file.clone().text()).toBe(200);
  expect(await file.json()).toMatchObject({ file: { id: row.id, path: 'docs/a.txt' } });

  const folder = await fixture.move('docs', 'docs');
  expect(folder.status, await folder.clone().text()).toBe(200);
  expect(await folder.json()).toEqual({ status: 'ok', moved: 0 });

  expect(fixture.calls.writes).toBe(0);
  expect(await (await fixture.download('docs/a.txt')).text()).toBe('alpha');
}
