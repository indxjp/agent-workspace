/* global console */

/** @param {Pick<import('./types.mjs').SelfTestContext,'check'|'x'>} context */
export function runIntersectionCases({ check, x }) {
  console.log('\nintersection detector');

  check('identical globs intersect', x('.github/**', '.github/**'), true);

  check(
    'nested globs intersect with no files on disk',
    x('packages/core/**', 'packages/core/src/db/**'),
    true,
  );

  check('sibling directories are disjoint', x('apps/web/**', 'apps/runner/**'), false);

  check(
    'the two globs of this task are disjoint',
    x('.github/**', 'scripts/check-file-ownership.mjs'),
    false,
  );

  check(
    'sibling scripts are disjoint',
    x('scripts/check-file-ownership.mjs', 'scripts/check-licenses.mjs'),
    false,
  );

  check(
    'a * glob and a deeper ** glob are disjoint',
    x('packages/core/*.json', 'packages/core/src/**'),
    false,
  );

  check(
    'a * glob and a same-depth ** glob intersect',
    x('packages/core/*.json', 'packages/core/**'),
    true,
  );

  check('wildcard package globs intersect', x('packages/*/src/**', 'packages/gateway/**'), true);

  check(
    'brace lists intersect on one branch',
    x('apps/{web,runner}/**', 'apps/runner/src/**'),
    true,
  );

  check(
    'brace lists disjoint on every branch',
    x('apps/{web,runner}/**', 'packages/cli/**'),
    false,
  );

  check(
    'overlap found only via the repo tree',
    x('**/*.ts', 'apps/runner/src/index.ts', ['apps/runner/src/index.ts']),
    true,
  );

  check(
    'no overlap when the tree is empty and prefixes differ',
    x('apps/**/*.ts', 'packages/**/*.ts', []),
    false,
  );

  check('root ** owns everything', x('**', 'apps/web/**'), true);
}
