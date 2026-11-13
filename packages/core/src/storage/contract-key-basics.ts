import { describe, expect, it } from 'vitest';
import { inferContentType } from './content-type.js';
import {
  keysOf,
  textAt,
  utf8,
  WORKSPACE_A,
  WORKSPACE_B,
  type ObjectStoreContractFixture,
  type WithObjectStore,
} from './contract-fixture.js';
export function defineKeyBasicsContract(
  withStore: WithObjectStore,
  setup: () => Promise<ObjectStoreContractFixture>,
): void {
  describe('objects', () => {
    it('read() and head() are null for a missing child beneath an existing object key', async () => {
      await withStore(async (store) => {
        await store.write('plain-file.txt', utf8('not a folder'), {});
        expect(await store.read('plain-file.txt/missing-child')).toBeNull();
        expect(await store.head('plain-file.txt/missing-child')).toBeNull();
      });
    });

    it('write() then read() round-trips bytes exactly, including a trailing newline', async () => {
      await withStore(async (store) => {
        await store.write('with-newline.txt', utf8('line one\nline two\n'), {});
        await store.write('without-newline.txt', utf8('line one\nline two'), {});
        expect(await textAt(store, 'with-newline.txt')).toBe('line one\nline two\n');
        expect(await textAt(store, 'without-newline.txt')).toBe('line one\nline two');
      });
    });

    it('write() replaces an existing object rather than appending to it', async () => {
      await withStore(async (store) => {
        await store.write('report.txt', utf8('first'), {});
        await store.write('report.txt', utf8('second, longer than "first"'), {});
        await store.write('report.txt', utf8('third'), {});
        expect(await textAt(store, 'report.txt')).toBe('third');
        expect((await store.head('report.txt'))?.sizeBytes).toBe(5);
      });
    });

    it('delete() removes an object, and a second delete() of the same key is not an error', async () => {
      await withStore(async (store) => {
        await store.write('to-delete.txt', utf8('gone soon'), {});
        await store.delete('to-delete.txt');
        expect(await store.head('to-delete.txt')).toBeNull();
        // R-15 §1c, verified against MinIO and local fs alike: deleting a missing key is success.
        await expect(store.delete('to-delete.txt')).resolves.toBeUndefined();
        await expect(store.delete('never-existed-at-all.txt')).resolves.toBeUndefined();
      });
    });

    it('one level of listPage() reports a folder, and a file with its size and content type', async () => {
      await withStore(async (store, { contentTypeFromName }) => {
        await store.write('contracts/agreement.pdf', utf8('pdf bytes'), {});
        await store.write('instructions.md', utf8('# hi'), {});
        const { entries } = await store.listPage('');
        expect(entries).toEqual([
          { kind: 'folder', key: 'contracts' },
          expect.objectContaining({
            kind: 'file',
            key: 'instructions.md',
            sizeBytes: 4,
            contentType: contentTypeFromName === true ? inferContentType('instructions.md') : null,
          }),
        ]);
        expect(await keysOf(store, '', true)).toEqual([
          'contracts/agreement.pdf',
          'instructions.md',
        ]);
      });
    });
  });

  it('a recursive listPage() stays beneath its prefix, never in a sibling that starts the same', async () => {
    await withStore(async (store) => {
      for (const key of ['p/deep/in.txt', 'p/in.txt', 'p-sibling/x.txt', 'p.txt', 'pq/x.txt']) {
        await store.write(key, utf8(key), {});
      }
      expect(await keysOf(store, 'p', true)).toEqual(['p/deep/in.txt', 'p/in.txt']);
      expect(await keysOf(store, 'p-sibling', true)).toEqual(['p-sibling/x.txt']);
    });
  });

  it("two workspaces never see each other's keys, even with the identical relative key", async () => {
    const { provider, teardown } = await setup();
    try {
      const storeA = provider.forWorkspace(WORKSPACE_A);
      const storeB = provider.forWorkspace(WORKSPACE_B);
      await storeA.write('shared/name.txt', utf8('workspace A'), {});
      expect(await storeB.head('shared/name.txt')).toBeNull();
      expect(await storeB.read('shared/name.txt')).toBeNull();
      expect(await keysOf(storeB, '', true)).toEqual([]);
      await storeB.write('shared/name.txt', utf8('workspace B'), {});
      expect(await textAt(storeA, 'shared/name.txt')).toBe('workspace A');
      expect(await textAt(storeB, 'shared/name.txt')).toBe('workspace B');
      await storeB.delete('shared/name.txt');
      expect(await textAt(storeA, 'shared/name.txt')).toBe('workspace A');
      expect(await keysOf(storeA, '')).toEqual(['shared']);
      expect(await keysOf(storeA, 'shared', true)).toEqual(['shared/name.txt']);
    } finally {
      await teardown();
    }
  });
}
