/**
 * The one caller type (refactoring part 06, step 9): `Caller` names exactly the facts a `Principal`
 * carries. `Principal implements Caller` stops `Caller` from naming a field the class lacks; this
 * test stops the other drift, a `Principal` field that `Caller` does not name.
 */
import { describe, expectTypeOf, it } from 'vitest';

import type { Caller, Principal } from './principal';

/** The data fields of `T`: every key whose value is not a function. */
type DataKeys<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => unknown ? never : K;
}[keyof T];

describe('the one Caller type', () => {
  it('names exactly the data fields of a Principal', () => {
    expectTypeOf<DataKeys<Principal>>().toEqualTypeOf<keyof Caller>();
  });

  it('is what a Principal is, field by field', () => {
    expectTypeOf<Pick<Principal, keyof Caller>>().toEqualTypeOf<Caller>();
  });
});
