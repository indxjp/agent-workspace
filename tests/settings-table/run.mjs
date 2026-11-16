/* global console */

/**
 * Write or check `docs/operations/settings.md` (refactoring part 03, step 7).
 *
 *   node tests/settings-table/run.mjs           write the file
 *   node tests/settings-table/run.mjs --check   exit non-zero when the committed file is stale
 *
 * The table is rendered from the settings modules' own catalogues, which are TypeScript, so this
 * spawns vitest on `tests/settings-table.test.ts`, as `tests/platform-matrix/run.mjs` does. That
 * test also fails when a catalogue misses a variable its parser reads.
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { URL } from 'node:url';

const [flag, ...rest] = process.argv.slice(2);
if (rest.length > 0 || (flag !== undefined && flag !== '--check')) {
  console.error('usage: node tests/settings-table/run.mjs [--check]');
  process.exit(2);
}
const check = flag === '--check';

const root = new URL('../../', import.meta.url);
// Its own config reads the runner's dependencies from `src`, since nothing is built yet.
const testArguments = [
  'vitest',
  'run',
  '--config',
  'tests/settings-table/vitest.config.ts',
  'tests/settings-table.test.ts',
];
const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm';
const argumentsForCommand =
  process.platform === 'win32'
    ? ['/d', '/s', '/c', `pnpm ${testArguments.join(' ')}`]
    : testArguments;

const environment = { ...process.env };
delete environment.SETTINGS_TABLE_WRITE;
const run = spawnSync(command, argumentsForCommand, {
  cwd: new URL('.', root),
  encoding: 'utf8',
  stdio: 'inherit',
  shell: false,
  env: check ? environment : { ...environment, SETTINGS_TABLE_WRITE: '1' },
});
if (run.error) throw run.error;
if (run.status !== 0) process.exit(run.status ?? 1);
console.log(
  check
    ? 'docs/operations/settings.md is current'
    : "wrote docs/operations/settings.md from each settings module's catalogue",
);
