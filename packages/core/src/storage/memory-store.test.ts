/**
 * The second backend the shared `ObjectStore` contract suite runs against.
 *
 * This file exists to make one claim checkable: `contract.ts` is backend-agnostic. It contains no
 * assertions of its own — every assertion it runs is the shared suite's, unmodified, and the only
 * thing this file supplies is a `setup()` returning a different implementation. That is exactly
 * the "Adding a backend" recipe `contract.ts`'s header documents, executed here rather than only
 * described, so an integration task adding S3 can see what its own file has to look like.
 */
import { describe, expect, it } from 'vitest';

import { defineObjectStoreContract, type ObjectStoreContractFixture } from './contract.js';
import { createInMemoryObjectStoreProvider } from './memory-store.js';

function setup(): Promise<ObjectStoreContractFixture> {
  return Promise.resolve({
    provider: createInMemoryObjectStoreProvider(),
    // Nothing outlives the provider: the map it closes over is unreachable once it is dropped.
    teardown: () => Promise.resolve(),
  });
}

defineObjectStoreContract('in-memory reference', setup);

describe('in-memory ObjectStore — backend-specific proof', () => {
  const WORKSPACE_ID = '55555555-5555-4555-8555-555555555555';

  it('copies bytes in and out, so a caller cannot mutate stored content through its own array', async () => {
    // The local-filesystem backend gets this from the filesystem; a Map does not, and the
    // contract's byte-identical assertions would otherwise pass here for the wrong reason.
    const store = createInMemoryObjectStoreProvider().forWorkspace(WORKSPACE_ID);
    const written = new Uint8Array([1, 2, 3]);
    await store.put('mutable.bin', { body: written });
    written[0] = 99;

    const readBack = await store.get('mutable.bin');
    expect(Buffer.from(readBack!.body)).toEqual(Buffer.from(new Uint8Array([1, 2, 3])));

    readBack!.body[1] = 88;
    const readAgain = await store.get('mutable.bin');
    expect(Buffer.from(readAgain!.body)).toEqual(Buffer.from(new Uint8Array([1, 2, 3])));
  });

  it('two providers do not share a map', async () => {
    const a = createInMemoryObjectStoreProvider().forWorkspace(WORKSPACE_ID);
    const b = createInMemoryObjectStoreProvider().forWorkspace(WORKSPACE_ID);
    await a.put('only-in-a.txt', { body: new TextEncoder().encode('a') });
    expect(await b.get('only-in-a.txt')).toBeNull();
  });
});
