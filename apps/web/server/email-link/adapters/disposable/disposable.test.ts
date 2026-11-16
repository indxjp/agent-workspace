import { describe, expect, it } from 'vitest';

import { DISPOSABLE_EMAIL_DOMAINS } from './domains';
import { createDisposableEmailList } from './disposable';

const list = createDisposableEmailList();

describe('the checked-in disposable domain list', () => {
  it('is lower-case, unique and made of registrable domains', () => {
    expect(new Set(DISPOSABLE_EMAIL_DOMAINS).size).toBe(DISPOSABLE_EMAIL_DOMAINS.length);
    for (const domain of DISPOSABLE_EMAIL_DOMAINS) {
      expect(domain).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/u);
    }
  });
});

describe('createDisposableEmailList', () => {
  it.each(['a@mailinator.com', 'A@MAILINATOR.COM', ' a@Yopmail.com ', 'a@guerrillamail.net'])(
    'refuses a listed domain regardless of case and space (%j)',
    (address) => {
      expect(list.isDisposable(address)).toBe(true);
    },
  );

  it('refuses a subdomain of a listed domain, at any depth', () => {
    expect(list.isDisposable('a@mx.mailinator.com')).toBe(true);
    expect(list.isDisposable('a@x.y.Mailinator.com')).toBe(true);
    expect(list.isDisposable('a@mailinator.com.')).toBe(true);
  });

  it('does not refuse a different domain that merely ends in the same letters', () => {
    expect(list.isDisposable('a@notmailinator.com')).toBe(false);
    expect(list.isDisposable('a@mailinator.com.example.org')).toBe(false);
    expect(list.isDisposable('a@example.com')).toBe(false);
  });

  it('judges the domain, not the local part', () => {
    expect(list.isDisposable('mailinator.com@example.com')).toBe(false);
  });

  it('does not refuse text with no domain', () => {
    expect(list.isDisposable('mailinator.com')).toBe(false);
    expect(list.isDisposable('')).toBe(false);
  });

  it('uses the list it is given', () => {
    const custom = createDisposableEmailList(['bad.test']);
    expect(custom.isDisposable('a@x.bad.test')).toBe(true);
    expect(custom.isDisposable('a@mailinator.com')).toBe(false);
  });
});
