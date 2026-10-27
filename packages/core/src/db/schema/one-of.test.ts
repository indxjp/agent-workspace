/**
 * `renderValueList` inlines values into DDL text, so its rejection path is the security-relevant
 * half of the module. A rejection path that is never exercised is not a rejection path.
 */
import { describe, expect, it } from 'vitest';

import { renderValueList } from './one-of.js';

describe('renderValueList', () => {
  it('renders a safe list', () => {
    expect(renderValueList(['owner', 'admin', 'openai-compatible'])).toBe(
      "('owner', 'admin', 'openai-compatible')",
    );
  });

  it('renders an underscore-separated list only when asked, and then rejects hyphens', () => {
    expect(renderValueList(['running', 'awaiting_approval'], { snake: true })).toBe(
      "('running', 'awaiting_approval')",
    );
    expect(() => renderValueList(['awaiting_approval'])).toThrow(/not a lower-case slug/u);
    expect(() => renderValueList(['openai-compatible'], { snake: true })).toThrow(
      /not a lower-case slug/u,
    );
    expect(() => renderValueList(['awaiting_'], { snake: true })).toThrow(/not a lower-case slug/u);
    expect(() => renderValueList(['awaiting__approval'], { snake: true })).toThrow(
      /not a lower-case slug/u,
    );
  });

  it.each([
    ['a quote', "own'er"],
    ['a backslash', 'own\\er'],
    ['a semicolon', 'owner;'],
    ['whitespace', 'own er'],
    ['upper case', 'Owner'],
    ['a leading digit', '1owner'],
    ['a trailing hyphen', 'owner-'],
    ['an empty string', ''],
    ['a comment opener', 'owner--'],
  ])('rejects %s', (_label, value) => {
    expect(() => renderValueList([value])).toThrow(/not a lower-case slug/u);
  });

  it('rejects an over-long value', () => {
    expect(() => renderValueList(['a'.repeat(65)])).toThrow(/not a lower-case slug/u);
  });

  it('rejects an empty list, which would make the CHECK unsatisfiable', () => {
    expect(() => renderValueList([])).toThrow(/value list is empty/u);
  });

  it('rejects duplicates', () => {
    expect(() => renderValueList(['owner', 'owner'])).toThrow(/appears twice/u);
  });
});
