import { SHARE_EXPIRIES, SHARE_SUBJECT_TYPES } from '@indx-workspace/contracts/shares';
import { describe, expect, it } from 'vitest';

import { shareStrings } from './share-dialog-messages';

// UX-15 in #2086: the share dialog had no Japanese (#2208 noted it).
describe('shareStrings', () => {
  const en = shareStrings('en');
  const ja = shareStrings('ja');

  it('has a Japanese word for every English one', () => {
    expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());
    for (const key of [
      'trigger',
      'close',
      'whoCanSee',
      'expiryLabel',
      'passphrase',
      'cancel',
      'copyLink',
      'share',
      'sharedPrivately',
      'sharedWithWorkspace',
      'notCreated',
    ] as const) {
      expect(ja[key], key).not.toBe('');
      expect(ja[key], key).not.toBe(en[key]);
    }
  });

  it('names every expiry and every kind of thing shared, in both languages', () => {
    for (const expiry of SHARE_EXPIRIES) {
      expect(en.expiry[expiry]).toBe(expiry);
      expect(ja.expiry[expiry]).not.toBe('');
    }
    for (const type of SHARE_SUBJECT_TYPES) {
      expect(en.intro(type)).toBe(`Choose who can see this ${type}.`);
      expect(ja.intro(type)).toMatch(/^この.+を見られる人を選んでください。$/u);
    }
  });

  it('keeps the one-time link last, so a hand copy picks up no full stop', () => {
    const url = 'https://aw.example.com/p/pub_x';
    for (const strings of [en, ja]) {
      expect(strings.oneTimeLink(url, true).endsWith(url)).toBe(true);
      expect(strings.oneTimeLink(url, false).endsWith(url)).toBe(true);
    }
    expect(ja.oneTimeLink(url, true)).toContain('二度と表示されません'.slice(0, 5));
  });
});
