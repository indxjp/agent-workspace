import { describe, expect, it } from 'vitest';

import { blockedStrings } from './blocked-tools';

describe('blocked tool messages', () => {
  it('keeps the same keys in English and Japanese', () => {
    expect(Object.keys(blockedStrings('ja')).sort()).toEqual(
      Object.keys(blockedStrings('en')).sort(),
    );
  });

  it('translates every string rather than repeating English', () => {
    const en = blockedStrings('en');
    const ja = blockedStrings('ja');
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(ja[key], key).not.toBe('');
      expect(ja[key], key).not.toBe(en[key]);
    }
  });
});
