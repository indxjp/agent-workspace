import { describe, expect, it } from 'vitest';

import { attachStrings, browserLocale } from './attach-messages';

describe('attach messages', () => {
  it('keeps the same keys in English and Japanese', () => {
    expect(Object.keys(attachStrings('ja')).sort()).toEqual(
      Object.keys(attachStrings('en')).sort(),
    );
  });

  it('translates every sentence rather than repeating English', () => {
    const en = attachStrings('en');
    const ja = attachStrings('ja');
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(ja[key], key).not.toBe('');
      expect(ja[key], key).not.toBe(en[key]);
    }
  });

  it('reads the browser language list', () => {
    expect(browserLocale(['ja-JP', 'en'])).toBe('ja');
    expect(browserLocale(['en-US'])).toBe('en');
    expect(browserLocale([])).toBe('en');
  });
});
