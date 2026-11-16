/* global console */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { TYPE_CHECK_PACKAGES } from '../app-kit/run.mjs';
import { copyExample } from './app-image.mjs';
import { differingFromExample, regenerate } from './regenerate.mjs';
import { TEST_RESULTS_REPORTER, APP_TESTS } from './lane-config.mjs';
import { testResults, agentOnDataOutcome } from './lane-results.mjs';
import { attempt, tail, stepOf } from './lane-process.mjs';
export { attempt, attemptAsync, tail, stepOf } from './lane-process.mjs';

/** @param {string} file @param {(value: Record<string, unknown>) => Record<string, unknown>} change */
function editJson(file, change) {
  writeFileSync(
    file,
    `${JSON.stringify(change(JSON.parse(readFileSync(file, 'utf8'))), null, 2)}\n`,
  );
}

/**
 * `manifest` with every `@indx-workspace/*` dependency at its tarball, added to its own
 * `overrides` (the template's security overrides stay), so a transitive one resolves there too.
 *
 * @param {Record<string, unknown>} manifest @param {Record<string, string>} tarballs
 */
export function withTarballDependencies(manifest, tarballs) {
  const specs = Object.fromEntries(
    Object.entries(tarballs).map(([name, tarball]) => [name, `file:${tarball}`]),
  );
  /** @param {Record<string, string> | undefined} section */
  const pinned = (section) =>
    section === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(section).map(([name, spec]) => [name, specs[name] ?? spec]),
        );
  return {
    ...manifest,
    dependencies: pinned(manifest['dependencies']),
    devDependencies: pinned(manifest['devDependencies']),
    overrides: { ...manifest['overrides'], ...specs },
  };
}

/**
 * @param {string} id @param {string} work @param {Record<string, string>} tarballs
 * @param {readonly string[]} takenOver the generated files the app has made its own
 */
export function regenerateStep(id, work, tarballs, takenOver) {
  try {
    const differing = differingFromExample(
      id,
      regenerate(id, path.join(work, 'regenerate', id), tarballs),
      takenOver,
    );
    return differing.length === 0
      ? { status: 'ok', reason: 'commands.sh writes the app again' }
      : { status: 'failed', reason: `differs from commands.sh: ${differing.join(', ')}` };
  } catch (error) {
    return { status: 'failed', reason: `regenerate failed: ${tail(String(error))}` };
  }
}

/** @param {string} id @param {string} copy @param {Record<string, string>} tarballs @param {NodeJS.ProcessEnv} env */
export function installStep(id, copy, tarballs, env) {
  copyExample(id, copy);
  editJson(path.join(copy, 'package.json'), (value) => withTarballDependencies(value, tarballs));
  const installed = stepOf('npm install', 'npm', ['install', '--no-audit', '--no-fund'], {
    cwd: copy,
    env,
  });
  if (installed.status !== 'ok') return installed;
  return stepOf(
    'npm install --save-dev <the repository TypeScript>',
    'npm',
    ['install', '--no-audit', '--no-fund', '--save-dev', ...TYPE_CHECK_PACKAGES],
    { cwd: copy, env },
  );
}

/**
 * The app's own `node:test` files under `tests/`, each test's result written by
 * {@link TEST_RESULTS_REPORTER}: the command's status and output, and the results it wrote
 * (`undefined` when it wrote none).
 *
 * @param {string} copy @param {string} work @param {NodeJS.ProcessEnv} env
 */
export function appTests(copy, work, env) {
  const resultsFile = path.join(work, `test-results-${path.basename(copy)}.jsonl`);
  rmSync(resultsFile, { force: true });
  console.log(`   $ ${APP_TESTS}`);
  const result = attempt(
    process.execPath,
    [
      '--test',
      `--test-reporter=${TEST_RESULTS_REPORTER}`,
      `--test-reporter-destination=${resultsFile}`,
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      'tests/**/*.test.ts',
    ],
    { cwd: copy, env },
  );
  const results = existsSync(resultsFile)
    ? testResults(readFileSync(resultsFile, 'utf8'))
    : undefined;
  return { status: result.status, output: result.output, results };
}

/**
 * @param {{ cells: { agentOnData: { ref: string } } }} benchmark @param {string} copy
 * @param {string} work @param {NodeJS.ProcessEnv} env
 */
export function testStep(benchmark, copy, work, env) {
  if (!existsSync(path.join(copy, 'tests')))
    return { status: 'gap', reason: 'the app has no tests/' };
  const result = appTests(copy, work, env);
  const command = {
    status: result.status,
    reason: `${APP_TESTS} exited ${String(result.status)}:\n${tail(result.output)}`,
  };
  if (result.status === 0 && result.results === undefined) {
    return { status: 'gap', reason: `${APP_TESTS} wrote no per-test results` };
  }
  return agentOnDataOutcome(benchmark, command, result.results ?? []);
}

/** @param {string} copy @param {NodeJS.ProcessEnv} env */
export function depcruiseStep(copy, env) {
  const result = attempt(
    'npx',
    [
      '--no-install',
      'depcruise',
      '--config',
      'dependency-cruiser.config.mjs',
      '--output-type',
      'json',
      '.',
    ],
    { cwd: copy, env },
  );
  let summary;
  try {
    summary = JSON.parse(result.stdout).summary;
  } catch {
    return { status: 'failed', reason: `depcruise printed no report:\n${tail(result.output)}` };
  }
  if (summary.totalCruised <= 1) {
    return {
      status: 'gap',
      reason: `depcruise cruised ${String(summary.totalCruised)} module(s): it proves nothing`,
    };
  }
  return result.status === 0 && summary.error === 0
    ? { status: 'ok', reason: `${String(summary.totalCruised)} modules, no violation` }
    : { status: 'failed', reason: `depcruise found ${String(summary.error)} violation(s)` };
}
