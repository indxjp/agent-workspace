import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from './index.js';

describe('@agent-workspace/core', () => {
  it('is wired into the pnpm workspace', () => {
    expect(PACKAGE_NAME).toBe('@agent-workspace/core');
  });
});
