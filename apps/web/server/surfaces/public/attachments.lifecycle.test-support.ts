import {
  ATTACHMENT_SESSION_ID,
  OTHER_ATTACHMENT_SESSION_ID,
  ATTACHMENT_ACTOR_HEADER,
} from './attachments.fixture.test-support';
import { streamOf } from './attachments.fixture.test-support';
import { SurfaceAttachmentResponseSchema } from '@indx-workspace/contracts/surfaces';
import { expect, it, vi } from 'vitest';

import { DELETE as deleteRoute, GET as downloadRoute } from '../../../app/api/files/[id]/route';
import { GET as listRoute } from '../../../app/api/files/route';
import { encodeFileId } from '../../files/file-id';
import { purgeSessionAttachments } from './attachments';

import type { AttachmentHarness } from './attachments.fixture.test-support';

export function registerAttachmentLifecycleTests(getHarness: () => AttachmentHarness) {
  // @story US-STO-11
  it('[US-STO-11][api][chat] purge removes the rows and their objects, and a second purge is a no-op', async () => {
    const h = getHarness();
    const { world, storage, upload, ctx, seed, rootObjects, legacyObjects, readyFiles } = h;
    expect((await upload('a.txt')).status).toBe(201);
    expect((await upload('b.txt')).status).toBe(201);
    await seed(OTHER_ATTACHMENT_SESSION_ID, 1);
    const kept = await storage.save(ctx(), {
      area: 'files',
      path: 'docs/promoted.txt',
      body: streamOf(1),
      maxBytes: 1,
      replace: false,
    });
    expect(kept.ok).toBe(true);

    await expect(purgeSessionAttachments(world.workspaceId, [ATTACHMENT_SESSION_ID])).resolves.toBe(
      2,
    );
    await expect(purgeSessionAttachments(world.workspaceId, [ATTACHMENT_SESSION_ID])).resolves.toBe(
      0,
    );
    expect((await readyFiles()).map((row) => row.path).sort()).toEqual([
      expect.stringMatching(new RegExp(`^\\.attachments/${OTHER_ATTACHMENT_SESSION_ID}/`)),
      'docs/promoted.txt',
    ]);
    expect(await legacyObjects()).toEqual([]);
    expect(await rootObjects()).toHaveLength(2);
    expect((await upload('after.txt')).status).toBe(201);
  });

  // @story US-STO-11
  it('[US-STO-11][api][chat] a files runtime without the catalog service answers 503 and stores nothing', async () => {
    const h = getHarness();
    const { upload, code, stored, install } = h;
    install(false);
    const before = await stored();
    const response = await upload('plain.txt');
    expect(response.status).toBe(503);
    expect(await code(response)).toBe('files_runtime_not_configured');
    expect(await stored()).toEqual(before);
  });

  // @story US-STO-11
  it('[US-STO-11][api][chat] purge returns 0 and removes nothing when the files runtime has no catalog service', async () => {
    const h = getHarness();
    const { world, upload, readyFiles, install } = h;
    expect((await upload('a.txt')).status).toBe(201);
    install(false);
    await expect(purgeSessionAttachments(world.workspaceId, [ATTACHMENT_SESSION_ID])).resolves.toBe(
      0,
    );
    expect(await readyFiles()).toHaveLength(1);
  });

  // @story US-STO-11
  it('[US-STO-11][api][chat] a failed catalogue write removes the object and leaks no cause text', async () => {
    const h = getHarness();
    const { world, upload, catalog, rootObjects, readyFiles } = h;
    const rows = await catalog();
    vi.spyOn(rows, 'confirm').mockRejectedValueOnce(new Error('SELECT secret FROM sql'));
    vi.spyOn(world.catalogs, 'forWorkspace').mockResolvedValue(rows);
    const response = await upload('a.txt');
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain('internal_error');
    expect(text).not.toContain('SELECT');
    expect(text).not.toContain('secret');
    expect(await rootObjects()).toEqual([]);
    expect(await readyFiles()).toEqual([]);
  });

  it('a saved attachment stays out of GET /api/files, and the files routes refuse its path', async () => {
    const h = getHarness();
    const { upload, code, catalog } = h;
    const saved = SurfaceAttachmentResponseSchema.parse(await (await upload('scan.txt')).json());
    const asMember = (method: string, path: string) =>
      new Request(`https://example.invalid${path}`, {
        method,
        headers: { [ATTACHMENT_ACTOR_HEADER]: 'member' },
      });

    const root = await listRoute(asMember('GET', '/api/files'));
    expect(root.status).toBe(200);
    expect(JSON.stringify(await root.json())).not.toContain('.attachments');
    expect((await listRoute(asMember('GET', '/api/files?path=.attachments'))).status).toBe(404);

    const id = encodeFileId(saved.path);
    const download = await downloadRoute(asMember('GET', `/api/files/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(download.status).toBe(404);
    expect(await code(download)).toBe('file_not_found');
    const removed = await deleteRoute(asMember('DELETE', `/api/files/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(removed.status).toBe(400);
    expect(await code(removed)).toBe('reserved_path');
    expect(await (await catalog()).get(saved.path)).toMatchObject({ status: 'ready' });
  });
}
