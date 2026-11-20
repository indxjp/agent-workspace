/* global console */

/**
 * Run one lane of the static checks (tests/static-checks/vitest.config.ts says what they are).
 *
 *   node tests/static-checks/run.mjs docs-check [file…]     in `pnpm docs:check`
 *   node tests/static-checks/run.mjs policy-check [file…]   `pnpm policy:check`
 *
 * The files are optional Vitest filters. The generators (`tests/platform-matrix/run.mjs`,
 * `tests/settings-table/run.mjs`) pass their own file, with their write variable set, to rewrite
 * what they generate.
 *
 * A static check is held to what ci.yml's "No test in the run was skipped" holds the test lanes to
 * (scripts/ci/vitest-no-skip.mjs reads only the Nx test reports): the run fails when it ran no
 * check, or when any check neither passed nor failed (`skip`, `todo`, `skipIf`).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

export const STATIC_CHECK_LANES = ['docs-check', 'policy-check'];

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/**
 * @param {string} lane one of {@link STATIC_CHECK_LANES}
 * @param {readonly string[]} files Vitest filters; none runs the whole lane
 * @param {NodeJS.ProcessEnv} environment
 * @returns {number} the exit status
 */
export function runStaticChecks(lane, files, environment) {
  if (!STATIC_CHECK_LANES.includes(lane)) {
    throw new Error(
      `unknown static-check lane ${lane}; expected one of ${STATIC_CHECK_LANES.join(', ')}`,
    );
  }
  const reportDirectory = mkdtempSync(path.join(tmpdir(), `static-checks-${lane}-`));
  const report = path.join(reportDirectory, 'report.json');
  const testArguments = [
    'vitest',
    'run',
    '--config',
    'tests/static-checks/vitest.config.ts',
    '--project',
    lane,
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${report}`,
    ...files,
  ];
  const command = process.platform === 'win32' ? (environment['ComSpec'] ?? 'cmd.exe') : 'pnpm';
  const argumentsForCommand =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', `pnpm ${testArguments.join(' ')}`]
      : testArguments;
  const run = spawnSync(command, argumentsForCommand, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: false,
    env: environment,
  });
  try {
    if (run.error) throw run.error;
    if (run.status !== 0) return run.status ?? 1;
    const unrun = notRun(JSON.parse(readFileSync(report, 'utf8')));
    if (unrun.length === 0) return 0;
    console.error(`${lane}: every static check must run; these did not:`);
    for (const line of unrun) console.error(`  ${line}`);
    return 1;
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
}

/**
 * What a Vitest JSON report says did not run: each check that neither passed nor failed, by full
 * name, or one line when the report holds no check at all.
 *
 * @param {unknown} report
 * @returns {string[]}
 */
export function notRun(report) {
  const files =
    /** @type {{ testResults?: { assertionResults?: { status: string, fullName: string }[] }[] }} */ (
      report
    ).testResults;
  const assertions = (files ?? []).flatMap((file) => file.assertionResults ?? []);
  if (assertions.length === 0) return ['(no static check ran)'];
  return assertions
    .filter(({ status }) => status !== 'passed' && status !== 'failed')
    .map(({ status, fullName }) => `${status}: ${fullName}`);
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(path.resolve(invokedPath)).href === import.meta.url
) {
  const [lane, ...files] = process.argv.slice(2);
  if (lane === undefined || !STATIC_CHECK_LANES.includes(lane)) {
    console.error(
      `usage: node tests/static-checks/run.mjs <${STATIC_CHECK_LANES.join('|')}> [file…]`,
    );
    process.exit(2);
  }
  process.exit(runStaticChecks(lane, files, process.env));
}
