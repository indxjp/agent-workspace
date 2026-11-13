import { expect, it } from 'vitest';
import { type UploadHarnessFactory } from './service-upload.fixture.test-support';
export function registerUploadAuthorizationTests(harness: UploadHarnessFactory) {
  // @story US-STO-02
  it('[US-STO-02][unit][sdk] a failed signed replacement authorization releases only its reservation', async () => {
    const h = await harness();
    const old = await h.save('a.txt', 'old');
    const failing = () => Promise.reject(new Error('directory unavailable'));

    await expect(
      h.storage.reserveUpload(h.ctx, { path: 'a.txt', sizeBytes: 3, mayReplace: failing }),
    ).rejects.toThrow('directory unavailable');

    await expect(h.catalog.pending('a.txt')).resolves.toBeNull();
    await expect(h.catalog.get('a.txt')).resolves.toMatchObject({ id: old.id });
    await expect(h.objects.head(h.nameOf(old.objectId))).resolves.not.toBeNull();
  });

  // @story US-STO-02
  it('[US-STO-02][unit][sdk] an old mint whose authorization fails leaves the newer reservation in place', async () => {
    const h = await harness();
    await h.save('a.txt', 'old');
    let fail = (): void => undefined;
    let asked = (): void => undefined;
    const decided = new Promise<void>((resolve) => (asked = resolve));
    const first = h.storage.reserveUpload(h.ctx, {
      path: 'a.txt',
      sizeBytes: 3,
      mayReplace: () =>
        new Promise<boolean>((_, reject) => {
          fail = () => reject(new Error('directory unavailable'));
          asked();
        }),
    });
    await decided;
    // The owner mints again while the first request is still being decided.
    await expect(h.mint('a.txt', 3)).resolves.toMatchObject({ ok: true });
    const newer = await h.catalog.pending('a.txt');
    fail();

    await expect(first).rejects.toThrow('directory unavailable');
    await expect(h.catalog.pending('a.txt')).resolves.toEqual(newer);
  });
}
