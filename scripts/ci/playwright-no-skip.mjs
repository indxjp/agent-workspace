#!/usr/bin/env node
// The positive assertion that every browser test RAN and passed first time (audit F-14).
// Usage: playwright-no-skip.mjs [playwright-report/results.json]
// Reads Playwright's JSON report and fails on a skipped test (including a runtime test.skip), on a
// flaky one (passed only on retry), on any failure, and on a report with no tests at all.
import console from 'node:console';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const file = process.argv[2] ?? 'playwright-report/results.json';

/**
 * @typedef {{ title: string, specs?: Spec[], suites?: Suite[] }} Suite
 * @typedef {{ title: string, tests?: { projectName?: string, status: string }[] }} Spec
 */
/**
 * @param {Suite} suite
 * @param {string[]} trail
 * @returns {{ name: string, status: string }[]}
 */
function collect(suite, trail) {
  const here = suite.title === '' ? trail : [...trail, suite.title];
  return [
    ...(suite.specs ?? []).flatMap((spec) =>
      (spec.tests ?? []).map((t) => ({
        name: [...here, spec.title, `[${t.projectName ?? '?'}]`].join(' > '),
        status: t.status,
      })),
    ),
    ...(suite.suites ?? []).flatMap((s) => collect(s, here)),
  ];
}

/** @type {{ suites?: Suite[] }} */
let report;
try {
  report = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  console.error(
    `Could not read the Playwright JSON report at ${file}: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
const tests = (report.suites ?? []).flatMap((s) => collect(s, []));
if (tests.length === 0) {
  console.error(
    'The Playwright report contains no tests. A run that collected nothing is not a pass.',
  );
  process.exit(1);
}
const bad = tests.filter((t) => t.status !== 'expected');
if (bad.length > 0) {
  console.error(`${bad.length} of ${tests.length} browser test(s) did not pass first time:`);
  for (const t of bad) console.error(`  [${t.status}] ${t.name}`);
  console.error('A skipped test is not a passed test and a flaky one hides a defect.');
  process.exit(1);
}
console.log(`Every one of the ${tests.length} browser tests ran and passed first time.`);
