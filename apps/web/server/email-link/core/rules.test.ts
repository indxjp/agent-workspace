import { EMAIL_LINK_TTL_SECONDS } from '@indx-workspace/contracts/email-link';
import { describe, expect, it } from 'vitest';

import {
  EMAIL_LINK_ADDRESS_WINDOW_MS,
  EMAIL_LINK_ISSUES_PER_ADDRESS,
  EMAIL_LINK_ISSUES_PER_MINUTE_PER_CLIENT,
  EMAIL_LINK_VERIFIES_PER_MINUTE_PER_CLIENT,
  addressWindowStart,
  buildLinkUrl,
  linkExpiry,
} from './rules';

describe('the email-link limits', () => {
  it('are pinned', () => {
    expect(EMAIL_LINK_ISSUES_PER_MINUTE_PER_CLIENT).toBe(5);
    expect(EMAIL_LINK_VERIFIES_PER_MINUTE_PER_CLIENT).toBe(10);
    expect(EMAIL_LINK_ISSUES_PER_ADDRESS).toBe(3);
    expect(EMAIL_LINK_ADDRESS_WINDOW_MS).toBe(15 * 60 * 1000);
  });
});

describe('linkExpiry', () => {
  it('is the contract TTL after now, without moving now', () => {
    const now = new Date('2026-11-16T10:00:00.000Z');
    expect(linkExpiry(now).toISOString()).toBe('2026-11-16T10:15:00.000Z');
    expect(linkExpiry(now).getTime() - now.getTime()).toBe(EMAIL_LINK_TTL_SECONDS * 1000);
    expect(now.toISOString()).toBe('2026-11-16T10:00:00.000Z');
  });
});

describe('addressWindowStart', () => {
  it('is fifteen minutes before now', () => {
    expect(addressWindowStart(new Date('2026-11-16T10:00:00.000Z')).toISOString()).toBe(
      '2026-11-16T09:45:00.000Z',
    );
  });
});

describe('buildLinkUrl', () => {
  it('puts the token and the address in the fragment, not the query', () => {
    const url = new URL(buildLinkUrl('https://store.example.test', 'abc_-', 'a+b@example.com'));
    expect(url.pathname).toBe('/sign-in');
    expect(url.search).toBe('');
    expect(url.hash).toBe('#token=abc_-&email=a%2Bb%40example.com');
  });

  it('drops trailing slashes from the base and keeps a base path', () => {
    expect(buildLinkUrl('https://x.example.test/store//', 't', 'a@b.co')).toBe(
      'https://x.example.test/store/sign-in#token=t&email=a%40b.co',
    );
  });
});
