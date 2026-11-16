import { ATTACHMENT_SESSION_ID } from './attachments.fixture.test-support';
import { storageObjectName } from '@agent-workspace/core/storage';
import { SurfaceAttachmentResponseSchema } from '@indx-workspace/contracts/surfaces';
import { expect, it } from 'vitest';

import type { AttachmentHarness } from './attachments.fixture.test-support';

export function registerAttachmentSavingTests(getHarness: () => AttachmentHarness) {
  // @story US-STO-11
  it('[US-STO-11][api][chat] an attachment is saved through the service', async () => {
    const h = getHarness();
    const { world, upload, catalog, rootObjects, legacyObjects } = h;
    const response = await upload('scan.txt');
    expect(response.status, await response.clone().text()).toBe(201);
    const body = SurfaceAttachmentResponseSchema.parse(await response.json());
    expect(body.size).toBe(5);
    expect(body.path).toMatch(
      new RegExp(`^\\.attachments/${ATTACHMENT_SESSION_ID}/[0-9a-f-]{36}/scan\\.txt$`),
    );
    const row = await (await catalog()).get(body.path);
    expect(row).toMatchObject({ id: body.fileId, status: 'ready', sizeBytes: 5 });
    const objectId = row?.objectId ?? null;
    if (objectId === null) throw new Error('the row has no object id');
    expect(await rootObjects()).toEqual([storageObjectName(world.workspaceId, 'files', objectId)]);
    expect(await legacyObjects()).toEqual([]);
  });

  // @story US-STO-11
  it('[US-STO-11][api][chat] an archived project refuses attachments', async () => {
    const h = getHarness();
    const { upload, code, stored } = h;
    const before = await stored();
    h.session.projectArchivedAt = new Date();
    const refused = await upload('scan.txt');
    expect(refused.status).toBe(404);
    expect(await code(refused)).toBe('file_not_found');
    expect(await stored()).toEqual(before);

    h.session.projectArchivedAt = null;
    const restored = await upload('scan.txt');
    expect(restored.status, await restored.clone().text()).toBe(201);
    expect((await stored()).files).toHaveLength(1);
  });

  // @story US-STO-11
  it('[US-STO-11][api][chat] a console member attaches to their own session, not to another’s', async () => {
    const h = getHarness();
    const { world, upload, code, readyFiles } = h;
    // A console session is no surface visitor's: it has no surface, so only the member path admits it.
    h.session.surface = null;
    const unowned = await upload('scan.txt', 'hello', { actor: 'member' });
    expect(unowned.status, 'a session the member does not own').toBe(404);

    h.session.sessionOwner = world.principalId;
    const saved = await upload('scan.txt', 'hello', { actor: 'member' });
    expect(saved.status, await saved.clone().text()).toBe(201);
    expect((await readyFiles()).map((row) => row.path)).toEqual([
      expect.stringMatching(
        new RegExp(`^\\.attachments/${ATTACHMENT_SESSION_ID}/[0-9a-f-]{36}/scan\\.txt$`),
      ),
    ]);

    h.session.sessionOwner = crypto.randomUUID();
    const other = await upload('b.txt', 'hello', { actor: 'member' });
    expect(other.status).toBe(404);
    expect(await code(other)).toBe('file_not_found');
    expect(await readyFiles()).toHaveLength(1);
  });

  // @story US-STO-11
  it('[US-STO-11][api][chat] a console admin attaches to another member’s session', async () => {
    const h = getHarness();
    const { upload, readyFiles } = h;
    // Pins `mayWriteToSession`'s admin clause (`canAccessSession`'s rule). The RBAC matrix gives
    // Admin `sessions: OWN_ONLY`; if the route is moved onto it, this becomes a concealed 404.
    h.session.surface = null;
    h.session.sessionOwner = crypto.randomUUID();
    const saved = await upload('scan.txt', 'hello', { actor: 'admin' });
    expect(saved.status, await saved.clone().text()).toBe(201);
    expect(await readyFiles()).toHaveLength(1);
  });

  // @story US-STO-11
  it('[US-STO-11][api][chat] an archived project refuses a console member’s attachment', async () => {
    const h = getHarness();
    const { world, upload, code, stored } = h;
    h.session.surface = null;
    h.session.sessionOwner = world.principalId;
    const before = await stored();
    h.session.projectArchivedAt = new Date();
    const refused = await upload('scan.txt', 'hello', { actor: 'member' });
    expect(refused.status).toBe(404);
    expect(await code(refused)).toBe('file_not_found');
    expect(await stored()).toEqual(before);

    h.session.projectArchivedAt = null;
    const restored = await upload('scan.txt', 'hello', { actor: 'member' });
    expect(restored.status, await restored.clone().text()).toBe(201);
  });
}
