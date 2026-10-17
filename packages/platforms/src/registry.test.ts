import { PLATFORM_IDS } from '@indx-workspace/contracts/platforms';
import { describe, expect, it } from 'vitest';

import { PLATFORM_TARGETS, platformTarget } from './registry.js';

describe('PLATFORM_TARGETS', () => {
  it('has unique ids, all platform ids, in PLATFORM_IDS order', () => {
    const ids = PLATFORM_TARGETS.map((target) => target.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(PLATFORM_IDS.filter((id) => ids.includes(id)));
  });

  it('finds a registered target by id and nothing for the rest', () => {
    for (const target of PLATFORM_TARGETS) expect(platformTarget(target.id)).toBe(target);
    for (const id of PLATFORM_IDS) {
      if (!PLATFORM_TARGETS.some((target) => target.id === id)) {
        expect(platformTarget(id)).toBeUndefined();
      }
    }
  });
});
