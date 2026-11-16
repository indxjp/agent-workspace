/**
 * `isUnderAllowedPrefix`: the one rule that decides whether a folder is inside a connection's
 * allowed folder. It compares segment by segment and decodes nothing.
 */
import { describe, expect, it } from 'vitest';

import { isUnderAllowedPrefix } from './prefixes';

describe('isUnderAllowedPrefix', () => {
  it.each([
    ['reports', 'reports'],
    ['reports/2026', 'reports'],
    ['reports/2026/q1', 'reports/2026'],
    ['reports/', 'reports'],
  ])('%j is under %j', (prefix, allowed) => {
    expect(isUnderAllowedPrefix(prefix, allowed)).toBe(true);
  });

  it.each([
    ['reports-old/x', 'reports'],
    ['report', 'reports'],
    ['Reports/x', 'reports'],
    ['reports', 'reports/2026'],
    ['other/reports', 'reports'],
    ['%2e%2e/reports', 'reports'],
    ['reports', 'reports/'],
    ['anything', ''],
  ])('%j is not under %j', (prefix, allowed) => {
    expect(isUnderAllowedPrefix(prefix, allowed)).toBe(false);
  });

  it('does not decode: %2e%2e is an ordinary segment', () => {
    expect(isUnderAllowedPrefix('reports/%2e%2e', 'reports')).toBe(true);
    expect(isUnderAllowedPrefix('reports/%2e%2e', 'reports/..')).toBe(false);
  });
});
