import { describe, expect, it } from 'vitest';
import { asText, textAt, utf8, type WithObjectStore } from './contract-fixture.js';
import { RangeNotSatisfiableError } from './object-store.js';
import { listAll, streamToBytes } from './streams.js';
export function defineRangesContract(withStore: WithObjectStore): void {
  describe('a range that cannot be satisfied is refused identically everywhere', () => {
    const bad: ReadonlyArray<readonly [string, { start: number; end?: number }]> = [
      ['a negative start', { start: -5 }],
      ['a negative start with an end', { start: -5, end: 3 }],
      ['a fractional start', { start: 1.5 }],
      ['a fractional end', { start: 1, end: 2.5 }],
      ['NaN', { start: Number.NaN }],
      ['start after end', { start: 5, end: 2 }],
      ['a start at the object size', { start: 10 }],
      ['a start past the object size', { start: 99, end: 120 }],
    ];
    for (const [name, range] of bad) {
      it(`rejects ${name} with RangeNotSatisfiableError`, async () => {
        await withStore(async (store) => {
          if (!store.capabilities.range) return;
          await store.write('range.txt', utf8('0123456789'), {});
          await expect(store.read('range.txt', { range })).rejects.toThrow(
            RangeNotSatisfiableError,
          );
        });
      });
    }

    it('rejects any range on a zero-byte object, and still streams it whole', async () => {
      await withStore(async (store) => {
        if (!store.capabilities.range) return;
        await store.write('empty.txt', new Uint8Array(0), {});
        await expect(store.read('empty.txt', { range: { start: 0 } })).rejects.toThrow(
          RangeNotSatisfiableError,
        );
        await expect(store.read('empty.txt', { range: { start: 0, end: 0 } })).rejects.toThrow(
          RangeNotSatisfiableError,
        );
        const whole = await store.read('empty.txt');
        expect((await streamToBytes(whole!.body)).byteLength).toBe(0);
      });
    });

    it('clamps an end past the last byte', async () => {
      await withStore(async (store) => {
        if (!store.capabilities.range) return;
        await store.write('clamp.txt', utf8('0123456789'), {});
        const read = await store.read('clamp.txt', { range: { start: 8, end: 500 } });
        expect(asText(await streamToBytes(read!.body))).toBe('89');
        expect(read?.range).toEqual({ start: 8, end: 9 });
      });
    });

    it('a missing object is null, not a range error', async () => {
      await withStore(async (store) => {
        if (!store.capabilities.range) return;
        expect(await store.read('nope.txt', { range: { start: 0 } })).toBeNull();
      });
    });
  });

  describe('a write whose body fails', () => {
    function failingBody(): ReadableStream<Uint8Array> {
      let pulls = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls > 2) controller.error(new Error('source broke'));
          else controller.enqueue(new Uint8Array(1024).fill(7));
        },
      });
    }

    it('rejects, leaves no object behind and keeps the previous one intact', async () => {
      await withStore(async (store) => {
        await expect(store.write('half.bin', failingBody(), {})).rejects.toThrow('source broke');
        expect(await store.head('half.bin')).toBeNull();
        expect(await listAll(store, '')).toEqual([]);

        await store.write('kept.txt', utf8('original'), {});
        await expect(store.write('kept.txt', failingBody(), {})).rejects.toThrow();
        expect(await textAt(store, 'kept.txt')).toBe('original');
      });
    });

    it('a conditional write whose body fails writes nothing and leaves the named version current', async () => {
      await withStore(async (store) => {
        if (!store.capabilities.conditionalPut) return;
        await expect(
          store.write('fresh.bin', failingBody(), { ifNoneMatch: '*' }),
        ).rejects.toThrow();
        expect(await store.head('fresh.bin')).toBeNull();

        const kept = await store.write('kept.txt', utf8('original'), {});
        await expect(
          store.write('kept.txt', failingBody(), { ifMatch: kept.etag }),
        ).rejects.toThrow();
        expect(await textAt(store, 'kept.txt')).toBe('original');
        expect((await store.head('kept.txt'))?.etag).toBe(kept.etag);
        // Nothing replaced it, so a retry that names the same version still succeeds.
        await store.write('kept.txt', utf8('retried'), { ifMatch: kept.etag });
        expect(await textAt(store, 'kept.txt')).toBe('retried');
      });
    });
  });
}
