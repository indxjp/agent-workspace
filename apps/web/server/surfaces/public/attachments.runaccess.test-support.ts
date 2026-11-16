import {
  ATTACHMENT_SESSION_ID,
  OTHER_ATTACHMENT_SESSION_ID,
} from './attachments.fixture.test-support';
import { SurfaceAttachmentResponseSchema } from '@indx-workspace/contracts/surfaces';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';

import { createAgentRunResourceLoader } from '../../compose/resource-loader';
import { resolveRunAttachments } from '../../runs/attachments';

import type { AttachmentHarness } from './attachments.fixture.test-support';
import { memoryWorld } from './attachments.fixture.test-support';

export function registerAttachmentRunAccessTests(
  getHarness: () => AttachmentHarness,
  setup: typeof memoryWorld,
) {
  // @story US-STO-11
  it('[US-STO-11][api][run] an attached file reaches the run read-only', async () => {
    const h = getHarness();
    const { world, storage, visitor, upload, catalog } = h;
    const bytes = new TextEncoder().encode('hello');
    const body = SurfaceAttachmentResponseSchema.parse(await (await upload('scan.txt')).json());
    const row = await (await catalog()).get(body.path);
    expect(row).toMatchObject({ status: 'ready', objectId: expect.any(String) as unknown });
    const verdict = await resolveRunAttachments(
      { ...visitor, role: 'builder', userId: null } as never,
      [{ fileId: body.fileId }],
    );
    expect(verdict).toEqual({
      kind: 'ok',
      files: [{ fileId: body.fileId, path: body.path, kind: 'file' }],
    });

    const loader = createAgentRunResourceLoader({
      catalog: world.catalogs,
      storage,
    });
    const loaded = await loader.load(world.workspaceId, {
      files: [{ fileId: body.fileId, access: 'read' }],
      skillIds: [],
      connectorIds: [],
    });
    expect(loaded.files).toEqual([
      {
        kind: 'file',
        path: body.path,
        access: 'read',
        size: Buffer.byteLength(bytes),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ]);
  });

  // @story US-STO-11
  it('[US-STO-11][api][run] a console-attached file reaches the run on its session', async () => {
    const h = getHarness();
    const { world, upload, consoleRunner } = h;
    h.session.surface = null;
    h.session.sessionOwner = world.principalId;
    const saved = await upload('scan.txt', 'hello', { actor: 'member' });
    expect(saved.status, await saved.clone().text()).toBe(201);
    const body = SurfaceAttachmentResponseSchema.parse(await saved.json());
    expect(
      await resolveRunAttachments(
        consoleRunner(),
        [{ fileId: body.fileId }],
        ATTACHMENT_SESSION_ID,
      ),
    ).toEqual({ kind: 'ok', files: [{ fileId: body.fileId, path: body.path, kind: 'file' }] });
  });

  // @story US-STO-11
  it('[US-STO-11][api][run] a console run is refused another session’s or workspace’s attachment', async () => {
    const h = getHarness();
    const { world, upload, code, consoleRunner } = h;
    h.session.surface = null;
    h.session.sessionOwner = world.principalId;
    const body = SurfaceAttachmentResponseSchema.parse(
      await (await upload('scan.txt', 'hello', { actor: 'member' })).json(),
    );
    const requested = [{ fileId: body.fileId }];
    const statusOf = async (
      verdict: Awaited<ReturnType<typeof resolveRunAttachments>>,
    ): Promise<string> => (verdict.kind === 'ok' ? 'ok' : code(verdict.response));
    expect(
      await statusOf(
        await resolveRunAttachments(consoleRunner(), requested, ATTACHMENT_SESSION_ID),
      ),
    ).toBe('ok');
    expect(
      await statusOf(
        await resolveRunAttachments(consoleRunner(), requested, OTHER_ATTACHMENT_SESSION_ID),
      ),
      'a run on another session',
    ).toBe('file_not_found');
    expect(
      await statusOf(await resolveRunAttachments(consoleRunner(), requested, null)),
      'a run that opens a new session',
    ).toBe('file_not_found');
    const elsewhere = (await setup()).workspaceId;
    expect(
      await statusOf(
        await resolveRunAttachments(consoleRunner(elsewhere), requested, ATTACHMENT_SESSION_ID),
      ),
      'another workspace',
    ).toBe('file_not_found');
    h.session.sessionOwner = crypto.randomUUID();
    expect(
      await statusOf(
        await resolveRunAttachments(consoleRunner(), requested, ATTACHMENT_SESSION_ID),
      ),
      'a session the caller does not own',
    ).toBe('file_not_found');
  });
}
