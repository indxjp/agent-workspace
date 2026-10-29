/**
 * The legacy pending-delete marker object: the revision numbers it records are what let a resumed
 * delete remove the revision rows of a skill whose catalog row is already gone, so a malformed list
 * must read as none.
 */
import { describe, expect, it } from 'vitest';

import { createInMemoryCatalog } from '@agent-workspace/core/db';
import { createInMemoryObjectStoreProvider } from '@agent-workspace/core/storage';

import { skillDeleteMarkerKey } from './keys';
import { readLegacyPendingSkillDelete, skillSyncContext } from './pending-delete';

const legacyStore = () => createInMemoryObjectStoreProvider().forWorkspace('w');

const putMarker = (store: ReturnType<typeof legacyStore>, json: string) =>
  store.write(skillDeleteMarkerKey('demo'), new TextEncoder().encode(json), {
    contentType: 'application/json',
  });

describe('the legacy pending-delete marker', () => {
  // @story US-STO-08
  it('[US-STO-08][unit][sdk] reads the owner and the revision numbers it was written with', async () => {
    const store = legacyStore();
    await putMarker(store, '{"ownerPrincipalId":"p","revisions":[1,3]}');

    expect(await readLegacyPendingSkillDelete(store, 'demo')).toEqual({
      ownerPrincipalId: 'p',
      revisions: [1, 3],
    });
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] reads a marker without revisions, or with malformed ones, as none', async () => {
    const store = legacyStore();

    await putMarker(store, '{"ownerPrincipalId":"p"}');
    expect(await readLegacyPendingSkillDelete(store, 'demo')).toEqual({
      ownerPrincipalId: 'p',
      revisions: [],
    });

    for (const bad of ['"1"', '[0]', '[-1]', '[1.5]', '["1"]', '{}', 'null']) {
      await putMarker(store, `{"ownerPrincipalId":"p","revisions":${bad}}`);
      expect(await readLegacyPendingSkillDelete(store, 'demo')).toEqual({
        ownerPrincipalId: 'p',
        revisions: [],
      });
    }

    await putMarker(store, 'not json');
    expect(await readLegacyPendingSkillDelete(store, 'demo')).toEqual({
      ownerPrincipalId: null,
      revisions: [],
    });
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] finds the names pending as markers on every listing page', async () => {
    const store = legacyStore();
    for (let n = 0; n <= 1000; n += 1) {
      const name = `s${String(n).padStart(4, '0')}`;
      await store.write(skillDeleteMarkerKey(name), new TextEncoder().encode('{}'), {
        contentType: 'application/json',
      });
    }

    const { pendingDeletes } = await skillSyncContext(
      store,
      createInMemoryCatalog().forWorkspace('w'),
    );

    expect(pendingDeletes.size).toBe(1001);
    expect(pendingDeletes.has('s1000')).toBe(true);
  });
});
