import { describe, expect, it } from 'vitest';
import { textAt, utf8, type WithObjectStore } from './contract-fixture.js';
import { ObjectConflictError, type WriteOptions } from './object-store.js';
import { bytesToStream, streamToBytes } from './streams.js';
export function defineConditionalContract(withStore: WithObjectStore): void {
  describe('conditional write', () => {
    it('ifNoneMatch "*" creates once and then conflicts', async () => {
      await withStore(async (store) => {
        if (!store.capabilities.conditionalPut) return;
        await store.write('c.txt', utf8('first'), { ifNoneMatch: '*' });
        await expect(store.write('c.txt', utf8('second'), { ifNoneMatch: '*' })).rejects.toThrow(
          ObjectConflictError,
        );
        expect(await textAt(store, 'c.txt')).toBe('first');
      });
    });

    it('ifNoneMatch "*" conflicts on a body large enough to be uploaded in parts', async () => {
      await withStore(async (store) => {
        if (!store.capabilities.conditionalPut) return;
        // Above S3's 5 MiB part, so the condition must hold when the parts are completed.
        const size = 6 * 1024 * 1024;
        await store.write('big.bin', bytesToStream(new Uint8Array(size).fill(1)), {
          ifNoneMatch: '*',
        });
        await expect(
          store.write('big.bin', bytesToStream(new Uint8Array(size).fill(2)), {
            ifNoneMatch: '*',
          }),
        ).rejects.toThrow(ObjectConflictError);
        const found = await store.read('big.bin');
        const bytes = found === null ? null : await streamToBytes(found.body);
        expect(bytes?.length).toBe(size);
        expect(bytes?.every((byte) => byte === 1)).toBe(true);
      });
    });

    it('ifMatch replaces only the version it names, and conflicts on a stale or missing one', async () => {
      await withStore(async (store) => {
        if (!store.capabilities.conditionalPut) return;
        await expect(store.write('m.txt', utf8('x'), { ifMatch: '"nope"' })).rejects.toThrow(
          ObjectConflictError,
        );
        const v1 = await store.write('m.txt', utf8('v1'), {});
        const v2 = await store.write('m.txt', utf8('v2-longer'), { ifMatch: v1.etag });
        await expect(store.write('m.txt', utf8('v3'), { ifMatch: v1.etag })).rejects.toThrow(
          ObjectConflictError,
        );
        expect(await textAt(store, 'm.txt')).toBe('v2-longer');
        await store.write('m.txt', utf8('v3'), { ifMatch: v2.etag });
        expect(await textAt(store, 'm.txt')).toBe('v3');
      });
    });

    it('head() reports the etag the write returned', async () => {
      await withStore(async (store) => {
        const written = await store.write('w.txt', utf8('mine'), {});
        expect((await store.head('w.txt'))?.etag).toBe(written.etag);
      });
    });

    it('ifMatch with ifNoneMatch is refused, the body cancelled and nothing written', async () => {
      await withStore(async (store) => {
        let cancelled = false;
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>({
          pull: (controller) => {
            pulls += 1;
            if (pulls > 3) controller.close();
            else controller.enqueue(utf8('x'));
          },
          cancel: () => {
            cancelled = true;
          },
        });
        // A JavaScript caller can pass both; the type allows only one.
        const both = { ifNoneMatch: '*', ifMatch: '"any"' } as unknown as WriteOptions;
        await expect(store.write('both.txt', body, both)).rejects.toThrow(ObjectConflictError);
        expect(cancelled).toBe(true);
        expect(await store.head('both.txt')).toBeNull();
      });
    });

    it('two concurrent ifNoneMatch "*" writes: exactly one wins', async () => {
      await withStore(async (store) => {
        if (!store.capabilities.conditionalPut) return;
        const results = await Promise.allSettled([
          store.write('race.txt', bytesToStream(utf8('left')), { ifNoneMatch: '*' }),
          store.write('race.txt', bytesToStream(utf8('right')), { ifNoneMatch: '*' }),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const lost = results.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        expect(lost?.reason).toBeInstanceOf(ObjectConflictError);
      });
    });
  });
}
