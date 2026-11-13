import { expect, it } from 'vitest';
import { type UploadHarnessFactory } from './service-upload.fixture.test-support';
export function registerUploadVerificationTests(harness: UploadHarnessFactory) {
  // @story US-STO-02
  it('[US-STO-02][unit][sdk] an object that grows between head and read is deleted, not left', async () => {
    const h = await harness();
    await h.mint('a.txt', 3);
    const pending = await h.put('a.txt', 'abcdef');
    // The store reports the declared size at head time, then serves more bytes.
    Object.assign(h.objects, {
      head: () => Promise.resolve({ sizeBytes: 3, contentType: null, etag: 'x' }),
    });
    await expect(h.complete('a.txt')).resolves.toEqual({ ok: false, code: 'too_large' });
    await expect(h.catalog.pending('a.txt')).resolves.toBeNull();
    await expect(h.objects.read(h.nameOf(pending.objectId))).resolves.toBeNull();
  });

  // @story US-STO-02
  it('[US-STO-02][unit][sdk] the link binds the length where the store can and not where it cannot', async () => {
    const binding = await harness(true);
    await binding.mint('a.txt', 3);
    expect(binding.requests[0]).toMatchObject({
      method: 'PUT',
      contentLength: 3,
      requireBoundContentLength: true,
    });
    const azure = await harness(false);
    await azure.mint('a.txt', 3);
    expect(azure.requests[0]).toMatchObject({ requireBoundContentLength: false });
  });
}
