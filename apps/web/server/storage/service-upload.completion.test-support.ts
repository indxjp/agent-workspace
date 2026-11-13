import { expect, it } from 'vitest';
import { type UploadHarnessFactory } from './service-upload.fixture.test-support';
export function registerUploadCompletionTests(harness: UploadHarnessFactory) {
  // @story US-STO-02
  it('[US-STO-02][unit][sdk] a signed replace keeps the old object until complete, then swaps the rows', async () => {
    const h = await harness();
    const old = await h.save('a.txt', 'old');
    await expect(h.mint('a.txt', 3)).resolves.toMatchObject({ ok: true });
    const fresh = await h.put('a.txt', 'new');
    expect(fresh.objectId).not.toBe(old.objectId);
    await expect(h.catalog.get('a.txt')).resolves.toMatchObject({ id: old.id });
    await expect(h.objects.head(h.nameOf(old.objectId))).resolves.not.toBeNull();

    const done = await h.complete('a.txt');
    expect(done).toMatchObject({
      ok: true,
      row: { id: fresh.id, sizeBytes: 3, sha256: await sha256Of('new') },
    });
    // Published on a copy no link names; the uploaded object goes with the replaced one.
    const published = done.ok ? done.row.objectId : null;
    expect([fresh.objectId, old.objectId]).not.toContain(published);
    await expect(h.objects.head(h.nameOf(published))).resolves.not.toBeNull();
    await expect(h.objects.head(h.nameOf(fresh.objectId))).resolves.toBeNull();
    await expect(h.objects.head(h.nameOf(old.objectId))).resolves.toBeNull();
    await expect(h.catalog.pending('a.txt')).resolves.toBeNull();
    await expect(h.catalog.countPending()).resolves.toBe(0);
  });

  // @story US-STO-02
  it('[US-STO-02][unit][sdk] an oversize object is deleted with its pending row and the ready file is untouched', async () => {
    const h = await harness();
    const old = await h.save('a.txt', 'old');
    await h.mint('a.txt', 3);
    const fresh = await h.put('a.txt', 'far too long');

    await expect(h.complete('a.txt')).resolves.toEqual({ ok: false, code: 'too_large' });
    await expect(h.objects.head(h.nameOf(fresh.objectId))).resolves.toBeNull();
    await expect(h.catalog.pending('a.txt')).resolves.toBeNull();
    await expect(h.catalog.get('a.txt')).resolves.toMatchObject({ id: old.id });
    await expect(h.objects.head(h.nameOf(old.objectId))).resolves.not.toBeNull();
  });

  // @story US-STO-02
  it('[US-STO-02][unit][sdk] an object over the deployment limit is refused even when it matches the declared size', async () => {
    const h = await harness();
    await h.mint('a.txt', 12);
    const fresh = await h.put('a.txt', 'twelve bytes');

    await expect(h.complete('a.txt', 5)).resolves.toEqual({ ok: false, code: 'too_large' });
    await expect(h.objects.head(h.nameOf(fresh.objectId))).resolves.toBeNull();
    await expect(h.catalog.pending('a.txt')).resolves.toBeNull();
  });

  // @story US-STO-02
  it('[US-STO-02][unit][sdk] a missing or smaller object leaves the row pending', async () => {
    const h = await harness();
    await h.mint('a.txt', 5);
    await expect(h.complete('a.txt')).resolves.toEqual({ ok: false, code: 'not_verified' });
    await h.put('a.txt', 'abc');
    await expect(h.complete('a.txt')).resolves.toEqual({ ok: false, code: 'size_mismatch' });
    await expect(h.catalog.pending('a.txt')).resolves.not.toBeNull();
    await h.put('a.txt', 'abcde');
    await expect(h.complete('a.txt')).resolves.toMatchObject({ ok: true });
  });

  // @story US-STO-02
  it('[US-STO-02][unit][sdk] completing again answers the ready file, and a path with nothing is not found', async () => {
    const h = await harness();
    await h.mint('a.txt', 2);
    await h.put('a.txt', 'hi');
    const first = await h.complete('a.txt');
    await expect(h.complete('a.txt')).resolves.toEqual(first);
    await expect(h.complete('none.txt')).resolves.toEqual({ ok: false, code: 'not_found' });
  });

  // @story US-STO-02
  it('[US-STO-02][unit][sdk] a ready file whose object is gone is not answered as complete', async () => {
    const h = await harness();
    const old = await h.save('a.txt', 'old');
    await h.objects.delete(h.nameOf(old.objectId));
    await expect(h.complete('a.txt')).resolves.toEqual({ ok: false, code: 'not_verified' });
  });
}

import { sha256Of } from './service-upload.fixture.test-support';
