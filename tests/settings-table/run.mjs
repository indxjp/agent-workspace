/* global console */

/**
 * Write or check `docs/40-operate/operations/settings.md` (refactoring part 03, step 7).
 *
 *   node tests/settings-table/run.mjs           write the file
 *   node tests/settings-table/run.mjs --check   exit non-zero when the committed file is stale
 *
 * The table is rendered from the settings modules' own catalogues, which are TypeScript, so this
 * runs vitest on `tests/settings-table/settings-table.docs-check.ts`, as
 * `tests/platform-matrix/run.mjs` does. That file also fails when a catalogue misses a variable
 * its parser reads; `pnpm docs:check` runs it with the rest of the `docs-check` lane.
 */
import process from 'node:process';

import { runStaticChecks } from '../static-checks/run.mjs';

const [flag, ...rest] = process.argv.slice(2);
if (rest.length > 0 || (flag !== undefined && flag !== '--check')) {
  console.error('usage: node tests/settings-table/run.mjs [--check]');
  process.exit(2);
}
const check = flag === '--check';

const environment = { ...process.env };
delete environment.SETTINGS_TABLE_WRITE;
const status = runStaticChecks(
  'docs-check',
  ['tests/settings-table/settings-table.docs-check.ts'],
  check ? environment : { ...environment, SETTINGS_TABLE_WRITE: '1' },
);
if (status !== 0) process.exit(status);
console.log(
  check
    ? 'docs/40-operate/operations/settings.md is current'
    : "wrote docs/40-operate/operations/settings.md from each settings module's catalogue",
);
