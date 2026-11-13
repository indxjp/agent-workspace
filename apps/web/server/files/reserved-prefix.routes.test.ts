/** The files routes and the reserved `.attachments/` prefix. Harness: `routes.test-support.ts`. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as listRoute, POST as uploadRoute } from '../../app/api/files/route';
import { bytesToStream } from '@agent-workspace/core/storage';
import { clearApplicationContext } from '../application-context';
import type { CatalogFilesWorld } from './catalog-runtime-fixtures';
import { encodeFileId } from './file-id';
import {
  WORKSPACE_A,
  download,
  expectError,
  installDefaultWorld,
  remove,
  rename,
  req,
  upload,
} from './routes.test-support';

let world: CatalogFilesWorld;

beforeEach(() => {
  world = installDefaultWorld();
});

afterEach(() => {
  clearApplicationContext();
});

describe('the reserved .attachments/ prefix (ADR-0146 D6, issue #1308)', () => {
  const VISITOR_FILE = '.attachments/33333333-3333-4333-8333-333333333333/u1/scan.txt';

  const visitorCtx = {
    workspaceId: WORKSPACE_A,
    principalId: '37d41bbb-42d1-4a16-8f5d-de3fef42eed0',
    userId: null,
  };

  /** A visitor's upload is a catalog row like any other, saved by the surfaces through the service. */
  async function seedVisitorFile(): Promise<string> {
    const saved = await world.storage.save(visitorCtx, {
      area: 'files',
      path: VISITOR_FILE,
      maxBytes: 1024,
      replace: true,
      body: bytesToStream(new TextEncoder().encode('visitor')),
    });
    if (!saved.ok) throw new Error(`the visitor file was refused: ${saved.code}`);
    return encodeFileId(VISITOR_FILE);
  }

  it('refuses a member writing into it: upload, folder and rename destination', async () => {
    await expectError(await upload('.attachments/x/y.txt', '\u0001'), 400, 'reserved_path');

    const folder = await uploadRoute(
      req('POST', '/api/files', {
        workspace: WORKSPACE_A,
        headers: { 'x-folder-path': '.attachments/x' },
      }),
    );
    await expectError(folder, 400, 'reserved_path');

    expect((await upload('plain.txt', '\u0001')).status).toBe(201);
    await expectError(await rename('plain.txt', '.attachments/x/plain.txt'), 400, 'reserved_path');
  });

  it('conceals it from a member: download, list and the folder at the root', async () => {
    await seedVisitorFile();
    await expectError(await download(VISITOR_FILE), 404, 'file_not_found');

    const inside = await listRoute(
      req('GET', '/api/files?path=.attachments', { workspace: WORKSPACE_A }),
    );
    expect(inside.status).toBe(404);

    const root = await listRoute(req('GET', '/api/files', { workspace: WORKSPACE_A }));
    expect(((await root.json()) as { files: unknown[] }).files).toEqual([]);
  });

  it('refuses a member deleting a visitor file or its folder, which stay stored', async () => {
    const id = await seedVisitorFile();
    for (const path of [
      VISITOR_FILE,
      '.attachments/33333333-3333-4333-8333-333333333333',
      '.Attachments',
    ]) {
      await expectError(await remove(path, { recursive: true }), 400, 'reserved_path');
    }
    expect(await world.storage.get(visitorCtx, 'files', VISITOR_FILE)).not.toBeNull();
    expect(id).toBe(encodeFileId(VISITOR_FILE));
  });

  it('lets a member promote a visitor file by renaming it out, after which it is readable', async () => {
    await seedVisitorFile();
    const moved = await rename(VISITOR_FILE, 'kept/scan.txt');
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect(await moved.json()).toMatchObject({ file: { path: 'kept/scan.txt' } });
    const kept = await download('kept/scan.txt');
    expect(kept.status).toBe(200);
    expect(await kept.text()).toBe('visitor');
  });
});
