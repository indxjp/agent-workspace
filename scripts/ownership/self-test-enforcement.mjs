/* global console */
import { findViolations } from './globs.mjs';

/** @param {Pick<import('./types.mjs').SelfTestContext,'check'|'noRoot'>} context */
export function runEnforcementCases({ check, noRoot }) {
  console.log('\nownership enforcement');

  const owns = ['.github/**', 'scripts/check-file-ownership.mjs'];

  /** @param {string[]} files */
  const v = (files) => findViolations(owns, files, noRoot);

  check(
    'an in-bounds diff has no violations',
    v([
      '.github/workflows/ci.yml',
      '.github/pull_request_template.md',
      'scripts/check-file-ownership.mjs',
    ]),
    [],
  );

  check(
    'an out-of-bounds file is caught',
    v(['.github/workflows/ci.yml', 'packages/core/src/index.ts']),
    ['packages/core/src/index.ts'],
  );

  check('a sibling script is caught', v(['scripts/check-licenses.mjs']), [
    'scripts/check-licenses.mjs',
  ]);

  check('a root manifest edit is caught', v(['package.json', 'pnpm-lock.yaml']), [
    'package.json',
    'pnpm-lock.yaml',
  ]);

  check('a near-miss path is caught', v(['github/workflows/ci.yml']), ['github/workflows/ci.yml']);
}
