// A coverage fixture (../../../coverage.test.ts): both branches of the script are tested.
import { expect, it } from 'vitest';

import { sign } from './skills/calc/scripts/calc.mjs';

it('tells a negative number from the others', () => {
  expect(sign(-1)).toBe('negative');
  expect(sign(1)).toBe('not negative');
});
