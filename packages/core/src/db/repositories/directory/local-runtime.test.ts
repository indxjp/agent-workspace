import { describe, expect, it } from 'vitest';

import { groupByOwner } from './local-runtime.js';

describe('groupByOwner', () => {
  it('groups key principals by the owner they act for, falling back to the target', () => {
    const groups = groupByOwner(
      [
        { id: 'key-1', actsForPrincipalId: 'alice' },
        { id: 'key-2', actsForPrincipalId: null },
        { id: 'key-3', actsForPrincipalId: 'bob' },
        { id: 'key-4', actsForPrincipalId: 'alice' },
        { id: 'key-5', actsForPrincipalId: null },
      ],
      'target',
    );
    expect([...groups]).toEqual([
      ['alice', ['key-1', 'key-4']],
      ['target', ['key-2', 'key-5']],
      ['bob', ['key-3']],
    ]);
  });

  it('returns no group when there is no key principal', () => {
    expect(groupByOwner([], 'target').size).toBe(0);
  });
});
