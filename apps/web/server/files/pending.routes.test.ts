/**
 * Folder deletes the files routes refuse, and the writes an upload in flight refuses. Harness:
 * `routes.test-support.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { POST as uploadRoute } from '../../app/api/files/route';
import { listCatalogFiles } from '@agent-workspace/core/db';
import { clearApplicationContext } from '../application-context';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import {
  WORKSPACE_A,
  download,
  expectError,
  installDefaultWorld,
  installSingleWorkspaceWorld,
  remove,
  rename,
  req,
  upload,
} from './routes.test-support';

let catalogs: ReturnType<typeof createInMemoryCatalogStore>;

beforeEach(() => {
  installDefaultWorld();
  catalogs = createInMemoryCatalogStore();
  installSingleWorkspaceWorld({ catalogs });
});

afterEach(() => {
  clearApplicationContext();
});

const uploadText = (filePath: string, text: string): Promise<Response> =>
  upload(filePath, text, { contentType: 'text/plain' });

describe('a refused folder delete through DELETE /api/files/:id', () => {
  it('answers 409 folder_not_empty without ?recursive and keeps the rows', async () => {
    expect((await uploadText('team/a.txt', 'x')).status).toBe(201);
    const before = await listCatalogFiles(catalogs.forWorkspaceSync(WORKSPACE_A));

    const response = await remove('team');

    await expectError(response, 409, 'folder_not_empty');
    expect(await listCatalogFiles(catalogs.forWorkspaceSync(WORKSPACE_A))).toEqual(before);
  });
});

/**
 * FX-7: a pending catalog row is an upload in flight. Every route that would write over it, move
 * it, or move a folder holding it answers `409 upload_in_progress` and leaves bytes and rows as
 * they were.
 */
describe('an upload in flight answers 409 upload_in_progress (FX-7)', () => {
  beforeEach(async () => {
    await catalogs.forWorkspaceSync(WORKSPACE_A).reserve('docs/pending.txt', {
      objectId: crypto.randomUUID(),
      ownerPrincipalId: '37d41bbb-42d1-4a16-8f5d-de3fef42eed0',
      sizeBytes: 3,
      contentType: 'text/plain',
    });
  });

  const expectUploadInProgress = (response: Response): Promise<void> =>
    expectError(response, 409, 'upload_in_progress');

  async function pendingRow(): Promise<unknown> {
    return catalogs.forWorkspaceSync(WORKSPACE_A).get('docs/pending.txt', { includePending: true });
  }

  it('refuses a relay upload over the pending path and writes no bytes', async () => {
    await expectUploadInProgress(await uploadText('docs/pending.txt', 'new'));
    expect((await download('docs/pending.txt')).status).toBe(404);
    expect(await pendingRow()).toMatchObject({ status: 'pending' });
  });

  it('refuses a folder created at the pending path and leaves no marker', async () => {
    const response = await uploadRoute(
      req('POST', '/api/files', {
        workspace: WORKSPACE_A,
        headers: { 'x-folder-path': 'docs/pending.txt' },
      }),
    );
    await expectUploadInProgress(response);
    expect(await pendingRow()).toMatchObject({ status: 'pending', kind: 'file' });
  });

  it('refuses a rename onto the pending path and keeps the source', async () => {
    expect((await uploadText('other.txt', 'abc')).status).toBe(201);
    await expectUploadInProgress(await rename('other.txt', 'docs/pending.txt'));
    expect(await (await download('other.txt')).text()).toBe('abc');
    expect(await pendingRow()).toMatchObject({ status: 'pending' });
  });

  it('refuses a folder move while an upload under it is pending and copies nothing', async () => {
    expect((await uploadText('docs/ready.txt', 'abc')).status).toBe(201);
    await expectUploadInProgress(await rename('docs', 'moved'));
    expect(await (await download('docs/ready.txt')).text()).toBe('abc');
    expect((await download('moved/ready.txt')).status).toBe(404);
    const rows = await listCatalogFiles(catalogs.forWorkspaceSync(WORKSPACE_A));
    expect(rows.map((row) => row.path)).toEqual(['docs', 'docs/ready.txt']);
  });
});
