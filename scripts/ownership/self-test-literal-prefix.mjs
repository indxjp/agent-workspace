/* global console */
import { literalPrefix, literalPrefixOverlap } from './globs.mjs';

/** @param {Pick<import('./types.mjs').SelfTestContext,'check'>} context */
export function runLiteralPrefixCases({ check }) {
  console.log('\nliteral prefix');

  check('prefix of a ** glob', literalPrefix('packages/core/**'), 'packages/core');

  check('prefix stops at the first wildcard', literalPrefix('packages/*/src/**'), 'packages');

  check('prefix of an exact path', literalPrefix('scripts/a.mjs'), 'scripts/a.mjs');

  check(
    'disjoint roots do not overlap',
    literalPrefixOverlap('apps/web/**', 'apps/runner/**'),
    false,
  );

  check(
    'nested prefixes overlap',
    literalPrefixOverlap('packages/core/**', 'packages/core/src/db/**'),
    true,
  );
}
