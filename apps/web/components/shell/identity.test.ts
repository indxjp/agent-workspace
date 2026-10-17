import { describe, expect, it } from 'vitest';

import { UNKNOWN_INITIALS, initialsFrom, roleLabel } from './identity';

describe('initialsFrom', () => {
  it('takes one letter from each of the first two words of the local part', () => {
    expect(initialsFrom('aya.ito@meridian.test')).toBe('AI');
    expect(initialsFrom('first_second_third@example.test')).toBe('FS');
    expect(initialsFrom('jo-anne-smith@example.test')).toBe('JA');
  });

  it('takes the first two letters when the local part is one word', () => {
    expect(initialsFrom('admin@example.test')).toBe('AD');
    expect(initialsFrom('a@example.test')).toBe('A');
  });

  it('says it does not know, rather than showing an empty circle', () => {
    expect(initialsFrom('...@example.test')).toBe(UNKNOWN_INITIALS);
    expect(initialsFrom('')).toBe(UNKNOWN_INITIALS);
    expect(initialsFrom(undefined)).toBe(UNKNOWN_INITIALS);
    expect(initialsFrom(null)).toBe(UNKNOWN_INITIALS);
    expect(initialsFrom(7)).toBe(UNKNOWN_INITIALS);
  });
});

describe('roleLabel', () => {
  it('capitalises the role the session carries', () => {
    expect(roleLabel('owner')).toBe('Owner');
  });

  it('names the failure instead of rendering an empty line', () => {
    expect(roleLabel('')).toBe('Unknown role');
    expect(roleLabel(undefined)).toBe('Unknown role');
  });
});
