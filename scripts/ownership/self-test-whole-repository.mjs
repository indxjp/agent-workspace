/* global console */

import { ownsEverything, trackedAreaNames } from './body.mjs';
import { nulSeparatedPaths, trackedFiles } from './repository.mjs';

/** @param {Pick<import('./types.mjs').SelfTestContext,'check'|'areaGlobs'>} context */
export function runWholeRepositoryCases({ check, areaGlobs }) {
  console.log('\nwhole-repo detection (semantic, not by spelling)');

  /** @param {...string} gs */
  const owns_all = (...gs) => Boolean(ownsEverything(gs));

  check('** owns everything', owns_all('**'), true);

  check('* owns everything (it misses nothing at the root)', owns_all('*'), true);

  check('**/* owns everything', owns_all('**/*'), true);

  check('./** owns everything', owns_all('./**'), true);

  check('**/** owns everything', owns_all('**/**'), true);

  check('**/*.* owns everything', owns_all('**/*.*'), true);

  check('**/?* owns everything', owns_all('**/?*'), true);

  check('a dotfile alone is not enough to be caught', owns_all('.gitignore'), false);

  check('.github/** does not own everything', owns_all('.github/**'), false);

  check('a deep glob does not own everything', owns_all('packages/core/src/db/**'), false);

  check('*/** owns everything below the root', owns_all('*/**'), true);

  check('**/*/** owns everything below the root', owns_all('**/*/**'), true);

  // The pair that keeps question (c) from swallowing honest declarations: enumerating the
  // directories that exist today does not reach one added tomorrow, so it is a scoped claim;
  // `*/**` does reach it, so it is not. Both sides are derived from the tree for the same
  // reason the probes are — a typed-out list here would stop describing the repository the
  // first time one of these tasks adds a top-level directory.
  check(
    'every tracked top-level dir, minus the root, is not everything',
    owns_all(...areaGlobs),
    false,
  );

  check(
    'all but one of those directories, still without the root, is not everything either',
    owns_all(...areaGlobs.slice(1)),
    false,
  );

  check('a lone *.* is not everything either', owns_all('*.*'), false);

  check('but the directories and the root together are', owns_all(...areaGlobs, '*.*'), true);

  // ...and so is the root plus all of them but one — question (a) counts the misses, so the
  // last directory on the line is not a way out of it. Derived, and asserted for each
  // directory in turn under "the one-directory escape hatch" above; this is the unit-level
  // spelling of the same property.
  if (areaGlobs.length >= 3) {
    check(
      'the root plus all but one of them is everything too',
      owns_all(...areaGlobs.slice(1), '*.*'),
      true,
    );
  }

  check(
    'the probe areas are the tracked top-level directories',
    trackedAreaNames(),
    [
      ...new Set(
        trackedFiles()
          .filter((f) => f.includes('/'))
          .map((f) => f.slice(0, f.indexOf('/'))),
      ),
    ].sort(),
  );

  check(
    'tracked UTF-8 paths are read verbatim instead of as Git-quoted byte escapes',
    trackedFiles().includes('tests/e2e/fixtures/日本語ファイル.txt'),
    true,
  );

  check(
    'machine-readable Git path lists preserve UTF-8 and embedded newlines',
    nulSeparatedPaths('日本語ファイル.txt\0directory/line\nbreak.txt\0'),
    ['日本語ファイル.txt', 'directory/line\nbreak.txt'],
  );
}
