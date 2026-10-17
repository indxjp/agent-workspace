/* global console */

/**
 * Write or check `docs/platform-matrix.md` (ADR-0133, #956).
 *
 *   node tests/platform-matrix/run.mjs           write the file
 *   node tests/platform-matrix/run.mjs --check   exit non-zero when the committed file is stale
 *
 * It spawns vitest rather than rendering the table itself, for the reason
 * `tests/engine-matrix/run.mjs` does: the renderer imports `packages/platforms` and
 * `packages/contracts` as TypeScript, and vitest is this repository's TypeScript runner.
 *
 * `tests/platform-matrix.test.ts` renders the same table and compares it to the committed file, so
 * a stale matrix is a failing test as well as a failing `pnpm docs:check`. With
 * `PLATFORM_MATRIX_WRITE=1` that same test writes instead of comparing, which is what the default
 * mode of this script sets.
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { URL } from 'node:url';

const [flag, ...rest] = process.argv.slice(2);
if (rest.length > 0 || (flag !== undefined && flag !== '--check')) {
  console.error('usage: node tests/platform-matrix/run.mjs [--check]');
  process.exit(2);
}
const check = flag === '--check';

const root = new URL('../../', import.meta.url);
const testArguments = ['vitest', 'run', 'tests/platform-matrix.test.ts'];
const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm';
const argumentsForCommand =
  process.platform === 'win32'
    ? ['/d', '/s', '/c', `pnpm ${testArguments.join(' ')}`]
    : testArguments;

const environment = { ...process.env };
delete environment.PLATFORM_MATRIX_WRITE;
const run = spawnSync(command, argumentsForCommand, {
  cwd: new URL('.', root),
  encoding: 'utf8',
  stdio: 'inherit',
  shell: false,
  env: check ? environment : { ...environment, PLATFORM_MATRIX_WRITE: '1' },
});
if (run.error) throw run.error;
if (run.status !== 0) process.exit(run.status ?? 1);
console.log(
  check
    ? 'docs/platform-matrix.md is current'
    : 'wrote docs/platform-matrix.md from each target’s own declaration',
);
