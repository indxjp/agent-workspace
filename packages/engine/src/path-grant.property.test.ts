/**
 * Property tests for {@link normaliseGrantPath} (F-21 property 1).
 *
 * `path-grant.test.ts` holds the spellings somebody thought of and `tests/formal/path-grant.test.ts`
 * replays the Lean vectors over a small finite domain; these quantify over arbitrary paths built
 * from the segments an escape is written in. On a failure fast-check prints the seed and path that
 * reproduce it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { normaliseGrantPath } from './path-grant.js';

const PROTECTED = '.claude';

/** One path segment, biased toward the ones that change a verdict. */
const segment = fc.oneof(
  fc.constantFrom('..', '.', '', 'a', 'b', 'docs', PROTECTED, 'C:', '...', '.hidden'),
  fc.string({ maxLength: 6 }),
);

/** A slash-joined path; the segments may themselves hold `\`, NUL or `/`. */
const anyPath = fc.array(segment, { maxLength: 8 }).map((segments) => segments.join('/'));

/** A segment that names a real directory: not empty, `.` or `..`, and no separator or NUL. */
const plainSegment = fc
  .string({ minLength: 1, maxLength: 6 })
  .filter((value) => !/[/\\\0]/u.test(value) && value !== '.' && value !== '..');

const RUNS = { numRuns: 400 };

/**
 * A normalised path whose first segment is a drive (`C:`) followed by more segments reads back as
 * a Windows absolute path, so normalising it again refuses it (`x/../C:/y` is accepted as `C:/y`).
 * The Lean model has the same shape. Pinned by the RF-001 characterization below and excluded
 * here by name, so every other input still has to be idempotent.
 */
function isDriveShaped(segments: readonly string[]): boolean {
  return segments.length > 1 && /^[A-Za-z]:$/u.test(segments[0] ?? '');
}

describe('normaliseGrantPath (property)', () => {
  it('is idempotent: a normalised path normalises to itself', () => {
    fc.assert(
      fc.property(anyPath, fc.constantFrom(null, PROTECTED), (input, protectedDirectory) => {
        const first = normaliseGrantPath(input, protectedDirectory);
        if (!first.ok || isDriveShaped(first.segments)) return;
        const second = normaliseGrantPath(first.path, protectedDirectory);
        expect(second).toEqual(first);
      }),
      RUNS,
    );
  });

  it('keeps an allowed path under the root: no empty, `.` or `..` segment, never absolute', () => {
    fc.assert(
      fc.property(anyPath, (input) => {
        const verdict = normaliseGrantPath(input);
        if (!verdict.ok) return;
        expect(verdict.segments.length).toBeGreaterThan(0);
        for (const part of verdict.segments) expect(['', '.', '..']).not.toContain(part);
        expect(verdict.path.startsWith('/')).toBe(false);
        expect(verdict.path).toBe(verdict.segments.join('/'));
      }),
      RUNS,
    );
  });

  it('never widens the verdict when `x/../` is inserted at a segment boundary', () => {
    fc.assert(
      fc.property(
        fc.array(segment, { maxLength: 8 }),
        fc.nat(),
        plainSegment,
        fc.constantFrom(null, PROTECTED),
        (segments, at, x, protectedDirectory) => {
          const cut = at % (segments.length + 1);
          const original = segments.join('/');
          // Prepending to `/a` or `C:/a` makes it a different, relative path: not an insertion.
          fc.pre(cut > 0 || !/^(?:\/|[A-Za-z]:\/)/u.test(original));
          const inserted = [...segments.slice(0, cut), x, '..', ...segments.slice(cut)].join('/');
          const widened = normaliseGrantPath(inserted, protectedDirectory);
          if (!widened.ok || isDriveShaped(widened.segments)) return;
          expect(normaliseGrantPath(original, protectedDirectory)).toEqual(widened);
        },
      ),
      RUNS,
    );
  });

  it('agrees on `\\` and `/`: a backslash spelling is never allowed as some other file', () => {
    fc.assert(
      fc.property(anyPath, (input) => {
        const slashed = normaliseGrantPath(input.replaceAll('\\', '/'));
        const backslashed = normaliseGrantPath(input.replaceAll('/', '\\'));
        if (input.includes('/') || input.includes('\\')) {
          expect(backslashed.ok).toBe(false);
        } else {
          expect(backslashed).toEqual(slashed);
        }
      }),
      RUNS,
    );
  });
});

describe('normaliseGrantPath drive-shaped output (characterization)', () => {
  it.fails(
    'RF-001: refuses `x/../C:/y`, whose normalised form `C:/y` reads back as absolute',
    () => {
      expect(normaliseGrantPath('x/../C:/y').ok).toBe(false);
    },
  );
});
