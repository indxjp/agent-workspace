/* global console */

/**
 * Write `docs/engine-matrix.md` (ENG-04, #303).
 *
 *   node tests/engine-matrix/run.mjs
 *
 * It spawns vitest rather than rendering the table itself, for one reason: the renderer imports
 * `packages/engine`, every `packages/engine-<id>` adapter and `packages/contracts` as TypeScript,
 * and vitest is this repository's TypeScript runner. `tests/driver-matrix/run.mjs` spawns vitest
 * for the same shape of reason — the evidence a matrix reports has to come from running the
 * thing, not from a second description of it.
 *
 * `tests/engine-matrix.test.ts` is the gate: it renders the same table and compares it to the
 * committed file, so a stale matrix is a failing test rather than a note nobody reads. With
 * `ENGINE_MATRIX_WRITE=1` that same test writes instead of comparing, which is what this script
 * sets.
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { URL } from 'node:url';

const root = new URL('../../', import.meta.url);
const testArguments = ['vitest', 'run', 'tests/engine-matrix.test.ts'];
const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm';
const argumentsForCommand =
  process.platform === 'win32'
    ? ['/d', '/s', '/c', `pnpm ${testArguments.join(' ')}`]
    : testArguments;

const run = spawnSync(command, argumentsForCommand, {
  cwd: new URL('.', root),
  encoding: 'utf8',
  stdio: 'inherit',
  shell: false,
  env: { ...process.env, ENGINE_MATRIX_WRITE: '1' },
});
if (run.error) throw run.error;
if (run.status !== 0) process.exit(run.status ?? 1);
console.log('wrote docs/engine-matrix.md from each adapter’s own declaration');
