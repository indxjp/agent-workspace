import { describe, expect, it } from 'vitest';

import { teamStrings } from './team-messages';

describe('team messages', () => {
  it('keeps the same keys in English and Japanese', () => {
    expect(Object.keys(teamStrings('ja')).sort()).toEqual(Object.keys(teamStrings('en')).sort());
  });

  it('translates every string rather than repeating English', () => {
    const en = teamStrings('en');
    const ja = teamStrings('ja');
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(ja[key], key).not.toBe('');
      expect(ja[key], key).not.toBe(en[key]);
    }
  });
});
