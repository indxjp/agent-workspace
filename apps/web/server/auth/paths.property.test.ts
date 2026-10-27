/**
 * Property tests for {@link classifyPath} (F-21 property 5): it never throws, and the spellings a
 * proxy or router may normalise differently — a trailing slash, a doubled slash, a
 * percent-encoded character — never move a path out of `/api` or into `/p`. A spelling may only
 * make the verdict stricter (`/%70/x` is not public), never looser. On a failure fast-check prints
 * the seed and path that reproduce it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { classifyPath } from './paths';

const segment = fc.oneof(
  fc.constantFrom('api', 'API', 'p', 'P', 'runs', '..', '.', 'x', 'apix', 'pp'),
  fc.string({ unit: fc.constantFrom('a', 'p', 'i', 'r', '.', '-', '_', '~', '1'), maxLength: 5 }),
);

/** An absolute, decoded path with no `%` of its own, so encoding it once is unambiguous. */
const canonical = fc.array(segment, { minLength: 1, maxLength: 6 }).map((s) => `/${s.join('/')}`);

/** Each character percent-encoded or not; `/` too, which a decoding reader turns back into one. */
function encodeSome(text: string, mask: readonly boolean[]): string {
  return Array.from(text)
    .map((character, index) =>
      mask[index % Math.max(mask.length, 1)] === true
        ? `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
        : character,
    )
    .join('');
}

/** Each `/` doubled or not, and optionally one trailing `/`. */
function reslash(text: string, mask: readonly boolean[], trailing: boolean): string {
  let index = 0;
  const doubled = text.replace(/\//gu, () =>
    mask[index++ % Math.max(mask.length, 1)] === true ? '//' : '/',
  );
  return trailing ? `${doubled}/` : doubled;
}

const RUNS = { numRuns: 2_000 };

describe('classifyPath (property)', () => {
  it('never throws, whatever it is handed', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.anything()), (input) => {
        expect(() => classifyPath(input)).not.toThrow();
      }),
      RUNS,
    );
  });

  it('keeps `/api` and never creates `/p` under doubled and trailing slashes', () => {
    fc.assert(
      fc.property(canonical, fc.array(fc.boolean()), fc.boolean(), (path, mask, trailing) => {
        // `/api/../` is `api` only by its raw spelling; doubling its slashes changes what `..`
        // removes, which is a different path rather than a respelling of the same one.
        fc.pre(!path.split('/').includes('..'));
        const base = classifyPath(path).surface;
        const variant = classifyPath(reslash(path, mask, trailing)).surface;
        if (base === 'api') expect(variant).toBe('api');
        if (variant === 'public') expect(base).toBe('public');
      }),
      RUNS,
    );
  });

  it('keeps `/api` and never creates `/p` under percent-encoding', () => {
    fc.assert(
      fc.property(canonical, fc.array(fc.boolean(), { minLength: 1 }), (path, mask) => {
        const base = classifyPath(path).surface;
        const variant = classifyPath(encodeSome(path, mask)).surface;
        if (base === 'api') expect(variant).toBe('api');
        if (variant === 'public') expect(base).toBe('public');
      }),
      RUNS,
    );
  });
});
