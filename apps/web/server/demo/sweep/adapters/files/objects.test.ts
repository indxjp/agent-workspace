import { describe, expect, it } from 'vitest';

import { discardWorkspaceObjects } from './objects';
import { createInMemoryObjectStoreProvider } from '../../../../storage/testing';

const bytes = new Uint8Array([1, 2, 3]);
const options = { contentType: 'application/octet-stream' };

describe('discardWorkspaceObjects', () => {
  it('removes every object of the workspace in every area, across pages, and no other workspace’s', async () => {
    const provider = createInMemoryObjectStoreProvider();
    const demo = provider.forWorkspace('demo');
    const other = provider.forWorkspace('other');
    // 1,203 objects: more than one listing page.
    for (let index = 0; index < 1203; index += 1) {
      await demo.write(`files/object-${String(index)}`, bytes, options);
    }
    await demo.write('session-state/blob-1', bytes, options);
    await other.write('files/theirs', bytes, options);

    expect(await discardWorkspaceObjects(demo)).toBe(1204);

    expect((await demo.listPage('', { recursive: true })).entries).toEqual([]);
    expect((await other.listPage('', { recursive: true })).entries).toHaveLength(1);
  });

  it('is a no-op for a workspace with no objects', async () => {
    const store = createInMemoryObjectStoreProvider().forWorkspace('empty');
    expect(await discardWorkspaceObjects(store)).toBe(0);
  });
});
