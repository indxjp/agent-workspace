import { describe, expect, it } from 'vitest';

import { NEXT_PATH_MAX_LENGTH, safeNextPath } from './next-path';

describe('safeNextPath', () => {
  it.each([
    ['/', '/'],
    ['/oauth/authorize?client_id=abc&state=x%20y', '/oauth/authorize?client_id=abc&state=x%20y'],
    ['/agents/1#frag', '/agents/1'],
    ['/a/../b', '/b'],
  ])('keeps the same-origin path %s', (raw, expected) => {
    expect(safeNextPath(raw)).toBe(expected);
  });

  it.each(['/%2F%2Fevil.example', '/%5Cevil.example', '/%2F%5Cevil.example'])(
    'keeps the percent-encoded %s as an undecoded same-origin path',
    (raw) => {
      expect(safeNextPath(raw)).toBe(raw);
    },
  );

  it.each([
    '%2F%2Fevil.example',
    '//evil.example',
    '/\\evil.example',
    '/\\\\evil',
    '\\\\evil',
    'https://evil.example',
    'http:/evil',
    'javascript:alert(1)',
    'evil',
    '/\r\nLocation: https://evil.example',
    '/\t/evil.example',
    '/ /evil',
    '/\u0000',
    '/.//evil.example',
    '/..//evil.example',
    '',
    `/${'a'.repeat(NEXT_PATH_MAX_LENGTH)}`,
  ])('refuses %j (open redirect)', (raw) => {
    expect(safeNextPath(raw)).toBeNull();
  });

  it.each([undefined, null, 42, ['/'], {}])('refuses a non-string %j', (raw) => {
    expect(safeNextPath(raw)).toBeNull();
  });
});
