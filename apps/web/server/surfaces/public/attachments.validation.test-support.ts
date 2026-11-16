import {
  OTHER_ATTACHMENT_SESSION_ID,
  ATTACHMENT_SURFACE,
  SURFACE_WITHOUT_ATTACHMENTS,
} from './attachments.fixture.test-support';
import { SurfaceAttachmentResponseSchema } from '@indx-workspace/contracts/surfaces';
import { expect, it } from 'vitest';

import type { AttachmentHarness } from './attachments.fixture.test-support';

export function registerAttachmentValidationTests(getHarness: () => AttachmentHarness) {
  it('gives two uploads of the same name two different paths', async () => {
    const h = getHarness();
    const { upload } = h;
    const first = SurfaceAttachmentResponseSchema.parse(await (await upload('a.txt')).json());
    const second = SurfaceAttachmentResponseSchema.parse(await (await upload('a.txt')).json());
    expect(first.path).not.toBe(second.path);
    expect(first.fileId).not.toBe(second.fileId);
  });

  it('answers a concealed 404 for a surface without the part, a member, a run token and no credential', async () => {
    const h = getHarness();
    const { upload, code, rootObjects, readyFiles } = h;
    h.session.surface = SURFACE_WITHOUT_ATTACHMENTS;
    const withoutPart = await upload('a.txt');
    expect(withoutPart.status).toBe(404);
    expect(await code(withoutPart)).toBe('file_not_found');
    h.session.surface = ATTACHMENT_SURFACE;
    for (const actor of ['member', 'run'] as const) {
      const refused = await upload('a.txt', 'hello', { actor });
      expect(refused.status, actor).not.toBe(201);
    }
    expect((await upload('a.txt', 'hello', { actor: 'member' })).status).toBe(404);
    expect((await upload('a.txt', 'hello', { actor: null })).status).toBe(401);
    expect(await readyFiles()).toEqual([]);
    expect(await rootObjects()).toEqual([]);
  });

  it('refuses another session’s id, writing nothing', async () => {
    const h = getHarness();
    const { upload, rootObjects, readyFiles } = h;
    const response = await upload('a.txt', 'hello', { session: OTHER_ATTACHMENT_SESSION_ID });
    expect(response.status).toBe(403);
    expect(await readyFiles()).toEqual([]);
    expect(await rootObjects()).toEqual([]);
  });

  it.each(['../x', '.env', 'a/b', 'a\\b', 'a\u0000b', '', 'é'.repeat(128)])(
    'refuses the name %j with 400 invalid_attachment_name',
    async (fileName) => {
      const h = getHarness();
      const { upload, code, rootObjects } = h;
      const response = await upload(fileName);
      expect(response.status).toBe(400);
      expect(await code(response)).toBe('invalid_attachment_name');
      expect(await rootObjects()).toEqual([]);
    },
  );

  it('refuses a missing name', async () => {
    const h = getHarness();
    const { upload } = h;
    expect((await upload(null)).status).toBe(400);
  });

  it('accepts a name of exactly 255 bytes', async () => {
    const h = getHarness();
    const { upload } = h;
    expect((await upload('a'.repeat(255))).status).toBe(201);
  });
}
