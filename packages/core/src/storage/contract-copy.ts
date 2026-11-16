import { describe, expect, it } from 'vitest';
import {
  asText,
  utf8,
  WORKSPACE_A,
  WORKSPACE_B,
  type ObjectStoreContractFixture,
  type WithObjectStore,
} from './contract-fixture.js';
import { toObjectKey, UnsafeObjectKeyError } from './key-safety.js';
import { workspaceFolder } from './object-name.js';
import { listAll, streamToBytes } from './streams.js';
export function defineCopyContract(
  withStore: WithObjectStore,
  setup: () => Promise<ObjectStoreContractFixture>,
): void {
  describe('copy() is a server-side copy', () => {
    it('the destination has the source bytes, content type and size; the source is unchanged', async () => {
      await withStore(async (store) => {
        await store.write('source.txt', utf8('payload'), { contentType: 'text/plain' });
        await store.copy('source.txt', 'dest.txt');
        const dest = await store.read('dest.txt');
        expect(asText(await streamToBytes(dest!.body))).toBe('payload');
        expect(dest?.meta).toMatchObject({ sizeBytes: 7, contentType: 'text/plain' });
        const source = await store.read('source.txt');
        expect(asText(await streamToBytes(source!.body))).toBe('payload');
      });
    });

    it('overwrites an existing destination', async () => {
      await withStore(async (store) => {
        await store.write('source.txt', utf8('new'), {});
        await store.write('dest.txt', utf8('stale'), {});
        await store.copy('source.txt', 'dest.txt');
        const dest = await store.read('dest.txt');
        expect(asText(await streamToBytes(dest!.body))).toBe('new');
      });
    });

    it('copying a source that does not exist is a no-op, not an error', async () => {
      await withStore(async (store) => {
        await expect(store.copy('never-written.txt', 'dest.txt')).resolves.toBeUndefined();
        expect(await store.head('dest.txt')).toBeNull();
      });
    });

    it('refuses an unsafe source or destination key', async () => {
      await withStore(async (store) => {
        await store.write('victim.txt', utf8('victim'), {});
        await expect(store.copy('../x', 'dest.txt')).rejects.toThrow(UnsafeObjectKeyError);
        await expect(store.copy('victim.txt', '../x')).rejects.toThrow(UnsafeObjectKeyError);
        expect(await store.head('dest.txt')).toBeNull();
      });
    });

    it('two workspaces cannot copy across each other, even at the identical relative key', async () => {
      const { provider, teardown } = await setup();
      try {
        const storeA = provider.forWorkspace(WORKSPACE_A);
        const storeB = provider.forWorkspace(WORKSPACE_B);
        await storeA.write('secret.txt', utf8('A only'), {});
        await storeB.copy('secret.txt', 'stolen.txt');
        // Workspace B's own `secret.txt` never existed, so its scoped copy source is empty.
        expect(await storeB.head('stolen.txt')).toBeNull();
      } finally {
        await teardown();
      }
    });

    it('scopes the copy source, so an unprefixed source naming another workspace finds nothing', async () => {
      const { provider, teardown } = await setup();
      try {
        const storeA = provider.forWorkspace(WORKSPACE_A);
        const storeB = provider.forWorkspace(WORKSPACE_B);
        await storeB.write('secret.txt', utf8('B only'), { contentType: 'text/plain' });
        const before = await storeB.head('secret.txt');
        // The backend-root key of B's object. Scoped, it names A's own (empty) subtree; a copy
        // that dropped the source prefix would read B's bytes into A.
        const unscoped = `${workspaceFolder(WORKSPACE_B)}secret.txt`;
        await storeA.copy(unscoped, 'stolen.txt');
        expect(await storeA.head('stolen.txt')).toBeNull();
        const after = await storeB.read('secret.txt');
        expect(asText(await streamToBytes(after!.body))).toBe('B only');
        expect(await storeB.head('secret.txt')).toEqual(before);
      } finally {
        await teardown();
      }
    });
  });

  describe('a foreign object the key guard refuses', () => {
    it('is skipped by every listing, not fatal', async () => {
      const { provider, teardown, plantRaw } = await setup();
      try {
        // Nothing but this module writes to the in-memory reference, so it cannot hold one.
        if (plantRaw === undefined) return;
        const store = provider.forWorkspace(WORKSPACE_A);
        await store.write('docs/real.txt', utf8('real'), {});
        const root = `${workspaceFolder(WORKSPACE_A)}docs`;
        // A console "create folder" is a zero-byte `name/` object; a bare `%` is a legal object
        // name everywhere and never a valid key.
        await plantRaw(`${root}/console-folder/`, new Uint8Array());
        await plantRaw(`${root}/50%.txt`, utf8('foreign'));

        const recursive = (await store.listPage('docs', { recursive: true })).entries;
        expect(recursive.map((entry) => entry.key)).toEqual(['docs/real.txt']);
        expect((await store.listPage('docs/console-folder')).entries).toEqual([]);
        const listings = [
          recursive,
          (await store.listPage('docs')).entries,
          await listAll(store, 'docs'),
          await listAll(store, 'docs', { recursive: true }),
        ];
        for (const entries of listings) {
          for (const entry of entries) expect(() => toObjectKey(entry.key)).not.toThrow();
          expect(entries.map((entry) => entry.key)).toContain('docs/real.txt');
        }
      } finally {
        await teardown();
      }
    });
  });
}
