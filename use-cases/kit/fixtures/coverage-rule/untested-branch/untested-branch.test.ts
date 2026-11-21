// A coverage fixture (../../../coverage.test.ts): the negative branch is never tested, on purpose.
import { expect, it } from 'vitest';

import { sign } from './skills/calc/scripts/calc.mjs';

it('tells a positive number apart', () => {
  expect(sign(1)).toBe('not negative');
});
