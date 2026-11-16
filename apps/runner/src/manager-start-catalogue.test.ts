import { expect, it } from 'vitest';
import { RUNTIME_DRIVERS } from '@indx-workspace/contracts/runtimes';
import { SERVED_RUNTIME_DRIVERS } from './manager-start.js';

it('SERVED_RUNTIME_DRIVERS > names only drivers in the contracts catalogue', () => {
  const catalogue = new Set<string>(RUNTIME_DRIVERS);
  expect(SERVED_RUNTIME_DRIVERS.filter((driver) => !catalogue.has(driver))).toEqual([]);
});
