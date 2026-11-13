import { API_KEY_PREFIX } from '@indx-workspace/contracts/api-keys';
import { describe, expect, it } from 'vitest';

import { AppApiKeySchema, isAppName } from './app-environment.js';

describe('the environment both appRuntime and serveRecipes read', () => {
  it('accepts a prefixed key of the header-safe alphabet only', () => {
    expect(AppApiKeySchema.safeParse(`${API_KEY_PREFIX}abc_DEF-123`).success).toBe(true);
    // The recipe runner once checked the prefix alone and accepted these.
    expect(AppApiKeySchema.safeParse(`${API_KEY_PREFIX}abc def`).success).toBe(false);
    expect(AppApiKeySchema.safeParse(`${API_KEY_PREFIX}abc\n`).success).toBe(false);
  });

  it('refuses a name that is no app schema name', () => {
    expect(isAppName('desk')).toBe(true);
    expect(isAppName('Not A Name!')).toBe(false);
  });
});
