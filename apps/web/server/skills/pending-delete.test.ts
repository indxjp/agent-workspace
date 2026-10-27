/**
 * The legacy pending-delete marker object: the revision numbers it records are what let a resumed
 * delete remove the revision rows of a skill whose catalog row is already gone, so a malformed list
 * must read as none.
 */
import { describe, expect, it } from 'vitest';

import { createInMemoryObjectStore } from '@agent-workspace/core/storage';

import { skillDeleteMarkerKey } from './keys';
import { readLegacyPendingSkillDelete } from './pending-delete';

const putMarker = (store: ReturnType<typeof createInMemoryObjectStore>, json: string) =>
  store.put(skillDeleteMarkerKey('demo'), {
    body: new TextEncoder().encode(json),
    contentType: 'application/json',
  });

describe('the legacy pending-delete marker', () => {
  // @story US-STO-08
  it('[US-STO-08][unit][sdk] reads the owner and the revision numbers it was written with', async () => {
    const store = createInMemoryObjectStore();
    await putMarker(store, '{"ownerPrincipalId":"p","revisions":[1,3]}');

    expect(await readLegacyPendingSkillDelete(store, 'demo')).toEqual({
      ownerPrincipalId: 'p',
      revisions: [1, 3],
    });
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] reads a marker without revisions, or with malformed ones, as none', async () => {
    const store = createInMemoryObjectStore();

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
});
