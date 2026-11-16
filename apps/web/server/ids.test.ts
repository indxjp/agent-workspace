import { UuidSchema } from '@indx-workspace/contracts';
import { describe, expect, it } from 'vitest';

import { counterIds, randomIds } from './ids';

describe('randomIds', () => {
  it('mints a different valid UUID each call', () => {
    const first = randomIds.newId();
    const second = randomIds.newId();
    expect(UuidSchema.parse(first)).toBe(first);
    expect(UuidSchema.parse(second)).toBe(second);
    expect(first).not.toBe(second);
  });

  it('cannot be replaced at runtime', () => {
    expect(Object.isFrozen(randomIds)).toBe(true);
  });
});

describe('counterIds', () => {
  it('counts from 1, in a form a uuid column accepts', () => {
    const ids = counterIds();
    expect([ids.newId(), ids.newId()]).toStrictEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ]);
  });

  it('stays a valid UUID past ten and past sixteen', () => {
    const ids = counterIds();
    const minted = Array.from({ length: 17 }, () => ids.newId());
    for (const id of minted) expect(UuidSchema.parse(id)).toBe(id);
    expect(minted[9]).toBe('00000000-0000-4000-8000-00000000000a');
    expect(minted[16]).toBe('00000000-0000-4000-8000-000000000011');
    expect(new Set(minted).size).toBe(17);
  });

  it('gives each generator its own count', () => {
    const a = counterIds();
    const b = counterIds();
    a.newId();
    expect(b.newId()).toBe('00000000-0000-4000-8000-000000000001');
  });
});
