import { expect, it } from 'vitest';
import { bytesToStream } from '@agent-workspace/core/storage';
import { MAX_PENDING_UPLOADS_PER_WORKSPACE } from '@indx-workspace/contracts/files';
import { type UploadHarnessFactory, bytesOf } from './service-upload.fixture.test-support';
export function registerUploadRelayTests(harness: UploadHarnessFactory) {
  // @story US-STO-02
  it('[US-STO-02][unit][sdk] a pending staging row does not use the pending-upload cap', async () => {
    const h = await harness();
    const staged = await h.storage.stage(h.ctx, bytesToStream(bytesOf('tar')), 1024);
    if (!staged.ok) throw new Error('stage refused');
    await expect(h.catalog.countPending()).resolves.toBe(0);
    for (let index = 0; index < MAX_PENDING_UPLOADS_PER_WORKSPACE; index += 1) {
      await expect(h.mint(`up/${index}.bin`, 1)).resolves.toMatchObject({ ok: true });
    }
    await expect(h.mint('over.bin', 1)).resolves.toEqual({ ok: false, code: 'too_many_pending' });
    await h.storage.unstage(h.ctx, staged.row);
  });

  // @story US-STO-02
  it('[US-STO-02][unit][sdk] a relay save over my own pending signed upload is refused and leaves its declared size', async () => {
    const h = await harness();
    await expect(h.mint('a.txt', 3)).resolves.toMatchObject({ ok: true });
    await expect(
      h.storage.save(h.ctx, {
        area: 'files',
        path: 'a.txt',
        body: bytesToStream(bytesOf('xyz')),
        maxBytes: 1024,
        replace: true,
      }),
    ).resolves.toEqual({ ok: false, code: 'upload_in_progress' });
    await expect(h.catalog.pending('a.txt')).resolves.toMatchObject({ sizeBytes: 3 });
    await h.put('a.txt', 'abc');
    await expect(h.complete('a.txt')).resolves.toMatchObject({ ok: true });
  });

  // @story US-STO-02
  it('[US-STO-02][unit][sdk] a mint during my own in-flight relay save is refused and signs nothing', async () => {
    const h = await harness();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await gate;
        controller.enqueue(bytesOf('abc'));
        controller.close();
      },
    });
    const saving = h.storage.save(h.ctx, {
      area: 'files',
      path: 'a.txt',
      body,
      maxBytes: 1024,
      replace: true,
    });
    while ((await h.catalog.pending('a.txt')) === null) await new Promise((r) => setTimeout(r, 1));
    await expect(h.mint('a.txt', 3)).resolves.toEqual({ ok: false, code: 'upload_in_progress' });
    expect(h.requests).toHaveLength(0);
    release();
    await expect(saving).resolves.toMatchObject({ ok: true });
  });

  // @story US-STO-02
  it('[US-STO-02][unit][sdk] completing a path whose pending row is a relay save in flight deletes nothing', async () => {
    const h = await harness();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await gate;
        controller.enqueue(bytesOf('abc'));
        controller.close();
      },
    });
    const saving = h.storage.save(h.ctx, {
      area: 'files',
      path: 'a.txt',
      body,
      maxBytes: 1024,
      replace: true,
    });
    let pending = await h.catalog.pending('a.txt');
    while (pending === null) {
      await new Promise((r) => setTimeout(r, 1));
      pending = await h.catalog.pending('a.txt');
    }
    // The save's object is written but its row is not yet confirmed: the store reports it.
    const realHead = h.objects.head.bind(h.objects);
    Object.assign(h.objects, {
      head: () => Promise.resolve({ sizeBytes: 3, contentType: null, etag: 'x' }),
    });
    const discarded: string[] = [];
    const realDelete = h.objects.delete.bind(h.objects);
    Object.assign(h.objects, {
      delete: (key: string) => (discarded.push(key), realDelete(key)),
    });
    await expect(h.complete('a.txt')).resolves.toEqual({ ok: false, code: 'upload_in_progress' });
    expect(discarded).toEqual([]);
    await expect(h.catalog.pending('a.txt')).resolves.toMatchObject({ id: pending.id });
    Object.assign(h.objects, { head: realHead, delete: realDelete });
    release();
    await expect(saving).resolves.toMatchObject({ ok: true });
  });
}
