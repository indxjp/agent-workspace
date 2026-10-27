import { describe, expect, it } from 'vitest';

import { isBuilderAgent } from './is-builder-agent';

describe('isBuilderAgent', () => {
  it('is true for the built-in Builder row', () => {
    expect(isBuilderAgent({ builtin: 'builder' })).toBe(true);
  });

  it('is false for a user agent', () => {
    expect(isBuilderAgent({})).toBe(false);
  });
});
