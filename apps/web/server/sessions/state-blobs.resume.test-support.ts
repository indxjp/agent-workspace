import { expect, it } from 'vitest';

import type { SessionBlobFixture } from './state-blobs.harness.test-support';
import { ENGINE, BLOB_KEY } from './state-blobs.fixture.test-support';
export function registerSessionBlobResumeTests(
  getFixture: () => Pick<SessionBlobFixture, 'harness'>,
) {
  // @story US-STO-09
  it('[US-STO-09][api][sdk] a blob that was never written answers absent, not an error', async () => {
    const testContext3 = getFixture();

    const h = await testContext3.harness();
    await expect(
      h.stateStore.getBlob({
        workspaceId: h.f.workspaceId,
        sessionId: h.f.sessionId,
        engine: ENGINE,
        blobKey: BLOB_KEY,
      }),
    ).resolves.toEqual({ ok: true, content: null });
  });

  // @story US-STO-09
  it('[US-STO-09][api][sdk] a resume refuses bytes that are not the ones it recorded', async () => {
    const testContext4 = getFixture();

    const h = await testContext4.harness();
    const api = h.as(h.user);
    expect((await api.put(new Uint8Array([1, 2, 3]))).status).toBe(204);
    const [name] = await h.objectNames();
    // Somebody else wrote over the object: a recorded digest only proves something if it is checked.
    await h.objects.write(name ?? '', streamOf(new Uint8Array([9, 9, 9])), {
      contentType: 'application/octet-stream',
    });

    await expect(
      h.stateStore.getBlob({
        workspaceId: h.f.workspaceId,
        sessionId: h.f.sessionId,
        engine: ENGINE,
        blobKey: BLOB_KEY,
      }),
    ).rejects.toThrow(/Refusing to replay a snapshot/u);
  });
}

import { streamOf } from './state-blobs.fixture.test-support';
