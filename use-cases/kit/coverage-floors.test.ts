/**
 * The gallery's coverage floors only go up (the Agent Store 100-use-case plan, §5.2), checked on
 * every run of the use cases' tests, not only where the coverage job's ratchet runs (the heavy
 * tier): each floor in `vitest.gallery.coverage.config.ts` must be at least the same floor on
 * `origin/main`. Where there is no `origin/main` or the file is not on it yet, the floors are compared
 * with themselves (nothing to go below): the repository's no-skip gate (scripts/ci/vitest-no-skip.mjs)
 * refuses a skipped test.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { METRICS, parseFloors } from '../../scripts/check-coverage-ratchet.mjs';
import { REPOSITORY_ROOT } from './nested-vitest.ts';

const CONFIG = 'vitest.gallery.coverage.config.ts';

type Floors = ReturnType<typeof parseFloors>;

/** The config's floors on `origin/main`, or `null` where it or the file is absent. */
function baseFloors(): Floors | null {
  try {
    const text = execFileSync('git', ['show', `origin/main:${CONFIG}`], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseFloors(text);
  } catch {
    return null;
  }
}

/** Every floor in `floors` lower than in `base`. */
function loweredFloors(floors: Floors, base: Floors): string[] {
  return METRICS.filter((metric) => floors[metric] < base[metric]).map(
    (metric) => `${metric}: ${String(base[metric])} → ${String(floors[metric])}`,
  );
}

describe('the gallery coverage floors', () => {
  const floors = parseFloors(readFileSync(path.join(REPOSITORY_ROOT, CONFIG), 'utf8'));
  const base = baseFloors();

  it('are no lower than on origin/main', () => {
    expect(loweredFloors(floors, base ?? floors)).toEqual([]);
  });

  it('a lowered floor is caught', () => {
    const at = { lines: 80, functions: 84, statements: 78, branches: 68 };
    expect(loweredFloors(at, at)).toEqual([]);
    expect(loweredFloors({ ...at, lines: 81 }, at)).toEqual([]);
    expect(loweredFloors({ ...at, branches: 67 }, at)).toEqual(['branches: 68 → 67']);
  });
});
