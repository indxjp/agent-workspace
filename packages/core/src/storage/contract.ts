/** Shared backend-agnostic ObjectStore suites. Each setup supplies a fresh provider and teardown. */
import { describe, expect, it } from 'vitest';
import { defineConditionalContract } from './contract-conditional.js';
import { defineCopyContract } from './contract-copy.js';
import { utf8, WORKSPACE_A, type ObjectStoreContractFixture } from './contract-fixture.js';
import { defineKeyBasicsContract } from './contract-key-basics.js';
import { defineKeySafetyContract } from './contract-key-safety.js';
import { defineListingContract } from './contract-listing.js';
import { defineRangesContract } from './contract-ranges.js';
import { defineReadWriteContract } from './contract-read-write.js';
import { defineSigningContract } from './contract-signing.js';
import { workspaceFolder } from './object-name.js';
import { type ObjectStore } from './object-store.js';
export { keysOf, textAt, type ObjectStoreContractFixture } from './contract-fixture.js';

export function defineObjectKeyContract(
  label: string,
  setup: () => Promise<ObjectStoreContractFixture>,
): void {
  describe(`ObjectStore keys and tenants — ${label}`, () => {
    async function withStore(
      run: (store: ObjectStore, fixture: ObjectStoreContractFixture) => Promise<void>,
    ): Promise<void> {
      const fixture = await setup();
      try {
        await run(fixture.provider.forWorkspace(WORKSPACE_A), fixture);
      } finally {
        await fixture.teardown();
      }
    }
    defineKeyBasicsContract(withStore, setup);
    defineKeySafetyContract(withStore);
  });
}

export function defineObjectStoreContract(
  label: string,
  setup: () => Promise<ObjectStoreContractFixture>,
): void {
  defineObjectKeyContract(label, setup);
  describe(`ObjectStore contract — ${label}`, () => {
    async function withStore(
      run: (store: ObjectStore, fixture: ObjectStoreContractFixture) => Promise<void>,
    ): Promise<void> {
      const fixture = await setup();
      const { provider, teardown } = fixture;
      try {
        await run(provider.forWorkspace(WORKSPACE_A), fixture);
      } finally {
        await teardown();
      }
    }
    defineReadWriteContract(withStore);
    defineRangesContract(withStore);
    defineConditionalContract(withStore);
    defineListingContract(withStore);
    defineCopyContract(withStore, setup);
    defineSigningContract(withStore, setup);
  });
}

export function defineOwnPagingContract(
  label: string,
  setup: () => Promise<ObjectStoreContractFixture>,
): void {
  describe(`ObjectStore own paging — ${label}`, () => {
    async function withStore(
      run: (store: ObjectStore, fixture: ObjectStoreContractFixture) => Promise<void>,
    ): Promise<void> {
      const fixture = await setup();
      try {
        await run(fixture.provider.forWorkspace(WORKSPACE_A), fixture);
      } finally {
        await fixture.teardown();
      }
    }

    it('pages more than one default page in key order, clamping a larger limit to 1000', async () => {
      await withStore(async (store, { plantRaw }) => {
        const expected = Array.from(
          { length: 1001 },
          (_, index) => `big/${String(index).padStart(4, '0')}.txt`,
        );
        // Seeded the way a foreign tool fills the folder where the backend allows it: a store
        // write is durable (two fsyncs on a folder), and 2,002 fsyncs beside the parallel suite's
        // disk traffic took this test past its timeout. Paging, not the write path, is under test.
        const seed = (key: string): Promise<unknown> =>
          plantRaw === undefined
            ? store.write(key, utf8('x'), {})
            : plantRaw(`${workspaceFolder(WORKSPACE_A)}${key}`, utf8('x'));
        for (let from = 0; from < expected.length; from += 50) {
          await Promise.all(expected.slice(from, from + 50).map(seed));
        }

        const first = await store.listPage('big');
        expect(first.entries).toHaveLength(1000);
        expect(first.cursor).not.toBeNull();
        expect((await store.listPage('big', { limit: 5000 })).entries).toHaveLength(1000);

        const keys = first.entries.map((entry) => entry.key);
        const second = await store.listPage('big', { cursor: first.cursor ?? '' });
        keys.push(...second.entries.map((entry) => entry.key));
        expect(second.cursor).toBeNull();
        expect(keys).toEqual(expected);
      });
    });
  });
}
