/* global console */

/**
 * Write or check `docs/30-reference/matrices/platform-matrix.md` (ADR-0133, #956).
 *
 *   node tests/platform-matrix/run.mjs           write the file
 *   node tests/platform-matrix/run.mjs --check   exit non-zero when the committed file is stale
 *
 * It runs vitest rather than rendering the table itself, for the reason
 * `tests/engine-matrix/run.mjs` does: the renderer imports `packages/platforms` and
 * `packages/contracts` as TypeScript, and vitest is this repository's TypeScript runner.
 *
 * `tests/platform-matrix/platform-matrix.docs-check.ts` renders the same table and compares it to
 * the committed file; `pnpm docs:check` runs it with the rest of the `docs-check` lane
 * (`tests/static-checks/run.mjs docs-check`). With `PLATFORM_MATRIX_WRITE=1` that same file writes
 * instead of comparing, which is what the default mode of this script sets.
 */
import process from 'node:process';

import { runStaticChecks } from '../static-checks/run.mjs';

const [flag, ...rest] = process.argv.slice(2);
if (rest.length > 0 || (flag !== undefined && flag !== '--check')) {
  console.error('usage: node tests/platform-matrix/run.mjs [--check]');
  process.exit(2);
}
const check = flag === '--check';

const environment = { ...process.env };
delete environment.PLATFORM_MATRIX_WRITE;
const status = runStaticChecks(
  'docs-check',
  ['tests/platform-matrix/platform-matrix.docs-check.ts'],
  check ? environment : { ...environment, PLATFORM_MATRIX_WRITE: '1' },
);
if (status !== 0) process.exit(status);
console.log(
  check
    ? 'docs/30-reference/matrices/platform-matrix.md is current'
    : 'wrote docs/30-reference/matrices/platform-matrix.md from each target’s own declaration',
);
