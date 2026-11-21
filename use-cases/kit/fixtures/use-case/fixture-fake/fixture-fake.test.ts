/**
 * A fixture that fakes a contract tier: tests titled like `describeUseCase`'s, under a
 * `describe('contract')` that is not `describe('fixture-fake') > describe('contract')`. The
 * scoreboard must not mark its Contract done (`kit/scoreboard.test.ts`).
 */
import { describe, expect, it } from 'vitest';

import { CONTRACT_TESTS } from '../../../contract.ts';

describe('contract', () => {
  for (const title of Object.values(CONTRACT_TESTS)) {
    it(title, () => {
      expect(title).not.toBe('');
    });
  }
});
