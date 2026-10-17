import { describe, expect, it } from 'vitest';

import { selectPreferredModel } from './preferred-model';

describe('selectPreferredModel', () => {
  it('returns the exact preferred id when it is listed, even beside dated releases', () => {
    expect(
      selectPreferredModel('claude-sonnet-4-5', [
        'claude-sonnet-4-5-20250929',
        'claude-sonnet-4-5',
      ]),
    ).toBe('claude-sonnet-4-5');
  });

  it('falls back to the newest dated release when only dated ids are listed', () => {
    expect(
      selectPreferredModel('claude-sonnet-4-5', [
        'claude-sonnet-4-5-20250101',
        'claude-sonnet-4-5-20250929',
        'claude-opus-4-1-20250805',
      ]),
    ).toBe('claude-sonnet-4-5-20250929');
  });

  it('ignores ids that only share a prefix without an eight-digit date suffix', () => {
    expect(
      selectPreferredModel('claude-sonnet-4-5', [
        'claude-sonnet-4-5-latest',
        'claude-sonnet-4-5-2025092',
        'claude-sonnet-4-50',
      ]),
    ).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(selectPreferredModel('gpt-5.1', [])).toBeNull();
  });
});
