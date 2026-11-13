import { describe, expect, it } from 'vitest';
import { inferContentType } from './content-type.js';
import {
  asText,
  expectBytesEqual,
  textAt,
  utf8,
  type WithObjectStore,
} from './contract-fixture.js';
import { UnsafeObjectKeyError } from './key-safety.js';
import { bytesToStream, streamToBytes } from './streams.js';
export function defineReadWriteContract(withStore: WithObjectStore): void {
  describe('head()', () => {
    it('is null for a missing key and reports size, content type and an etag for an object', async () => {
      await withStore(async (store) => {
        expect(await store.head('missing.txt')).toBeNull();
        await store.write('h.txt', utf8('12345'), { contentType: 'text/plain' });
        const meta = await store.head('h.txt');
        expect(meta).toMatchObject({ sizeBytes: 5, contentType: 'text/plain' });
        expect(meta?.etag).toEqual(expect.any(String));
        expect(meta?.etag).not.toBe('');
      });
    });

    it('changes the etag when the content changes', async () => {
      await withStore(async (store) => {
        await store.write('e.txt', utf8('one'), {});
        const first = await store.head('e.txt');
        await store.write('e.txt', utf8('two!'), {});
        const second = await store.head('e.txt');
        expect(second?.etag).not.toBe(first?.etag);
        expect(second?.sizeBytes).toBe(4);
      });
    });
  });

  describe('read() and write() stream bytes', () => {
    it('read() is null for a missing key', async () => {
      await withStore(async (store) => {
        expect(await store.read('never.txt')).toBeNull();
      });
    });

    it('write() accepts a multi-chunk stream, returns meta, and read() streams the same bytes back', async () => {
      await withStore(async (store, { contentTypeFromName }) => {
        const chunks = [utf8('alpha-'), utf8('beta-'), utf8('gamma')];
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        });
        const written = await store.write('s/stream.bin', body, { contentType: 'text/plain' });
        expect(written.sizeBytes).toBe(16);
        const read = await store.read('s/stream.bin');
        expect(read?.meta).toMatchObject({
          sizeBytes: 16,
          contentType:
            contentTypeFromName === true ? inferContentType('s/stream.bin') : 'text/plain',
        });
        expect(read?.meta.etag).toBe(written.etag);
        expect(asText(await streamToBytes(read!.body))).toBe('alpha-beta-gamma');
      });
    });

    it('write() accepts bytes, and read() sees them', async () => {
      await withStore(async (store) => {
        await store.write('b.txt', utf8('bytes'), {});
        expect(await textAt(store, 'b.txt')).toBe('bytes');
      });
    });

    it('write() round-trips binary bytes through a stream', async () => {
      await withStore(async (store) => {
        const bytes = new Uint8Array(70_000);
        for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7) % 256;
        await store.write('bin.bin', bytesToStream(bytes), {});
        const read = await store.read('bin.bin');
        expectBytesEqual(await streamToBytes(read!.body), bytes);
      });
    });

    // #1835 (STO-509): a write-back's deadline must stop a write or a read the store's SDK holds.
    it('write() with a signal already aborted rejects with its reason, writes nothing and cancels the body', async () => {
      await withStore(async (store) => {
        const stopped = new Error('stopped before the write');
        let cancelled: unknown;
        const body = new ReadableStream<Uint8Array>({
          cancel(reason) {
            cancelled = reason;
          },
        });
        await expect(
          store.write('aborted.txt', body, { signal: AbortSignal.abort(stopped) }),
        ).rejects.toBe(stopped);
        expect(cancelled).toBe(stopped);
        expect(await store.head('aborted.txt')).toBeNull();
      });
    });

    it('write() whose signal aborts while the body is still open rejects and leaves the key as it was', async () => {
      await withStore(async (store) => {
        await store.write('kept.txt', utf8('before'), {});
        const controller = new AbortController();
        const stalled = new ReadableStream<Uint8Array>({
          start(streamController) {
            streamController.enqueue(utf8('partial'));
          },
        });
        const writing = store.write('kept.txt', stalled, { signal: controller.signal });
        setTimeout(() => controller.abort(new Error('the deadline passed')), 50);
        await expect(writing).rejects.toThrow();
        expect(await textAt(store, 'kept.txt')).toBe('before');
      });
    });

    it('read() with a signal already aborted rejects, and a body whose signal aborts errors', async () => {
      await withStore(async (store) => {
        await store.write('r.bin', bytesToStream(new Uint8Array(200_000)), {});
        const stopped = new Error('stopped before the read');
        await expect(store.read('r.bin', { signal: AbortSignal.abort(stopped) })).rejects.toBe(
          stopped,
        );

        const controller = new AbortController();
        const found = await store.read('r.bin', { signal: controller.signal });
        controller.abort(new Error('stopped mid-read'));
        await expect(streamToBytes(found!.body)).rejects.toThrow();
      });
    });

    it('head(), read() and write() refuse an unsafe key like put() does', async () => {
      await withStore(async (store) => {
        await expect(store.write('../x', utf8('x'), {})).rejects.toThrow(UnsafeObjectKeyError);
        await expect(store.read('../x')).rejects.toThrow(UnsafeObjectKeyError);
        await expect(store.head('../x')).rejects.toThrow(UnsafeObjectKeyError);
      });
    });
  });

  describe('range reads', () => {
    it('serve a closed range, an open-ended range, and report the whole size', async () => {
      await withStore(async (store) => {
        if (!store.capabilities.range) return;
        await store.write('r.txt', utf8('0123456789'), {});
        const closed = await store.read('r.txt', { range: { start: 2, end: 5 } });
        expect(asText(await streamToBytes(closed!.body))).toBe('2345');
        expect(closed?.range).toEqual({ start: 2, end: 5 });
        expect(closed?.meta.sizeBytes).toBe(10);
        const open = await store.read('r.txt', { range: { start: 7 } });
        expect(asText(await streamToBytes(open!.body))).toBe('789');
        expect(open?.range).toEqual({ start: 7, end: 9 });
        const whole = await store.read('r.txt');
        expect(whole?.range).toBeNull();
      });
    });
  });
}
