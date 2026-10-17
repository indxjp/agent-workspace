#!/usr/bin/env node
// The positive assertion that every collected test RAN (ci.yml: the heavy-checks test shards and
// build-embedded). It reads each Nx test task's `<project root>/.vitest-report.json`, requires at
// least one report with at least one test, and fails on any test that neither passed nor failed,
// printing each by full name. ci.yml says why the rule is strict.
import console from 'node:console';
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

const roots = [
  '.',
  'apps/web',
  'apps/runner',
  'packages/aw',
  'packages/cli',
  'packages/contracts',
  'packages/core',
  'packages/create',
  'packages/egress-proxy',
  'packages/embedded',
  'packages/gateway',
  'packages/runtime',
  'packages/sdk',
];
const reports = roots.map((r) => `${r}/.vitest-report.json`).filter((p) => existsSync(p));
if (reports.length === 0) {
  console.error('No .vitest-report.json was written by any Nx test task.');
  console.error('Without a report this gate asserts nothing, so it fails.');
  process.exit(1);
}
/**
 * The slice of vitest's JSON reporter output this gate reads.
 * @typedef {{ status: string, fullName: string }} Assertion
 * @typedef {{ name: string, assertionResults?: Assertion[] }} TestFile
 * @typedef {'numPassedTests' | 'numFailedTests' | 'numPendingTests' | 'numTodoTests'} Count
 * @typedef {{ testResults: TestFile[] } & Record<Count, number>} Report
 */
/** @type {Report} */
const report = {
  testResults: [],
  numPassedTests: 0,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
};
for (const path of reports) {
  /** @type {Partial<Report>} */
  let one;
  try {
    one = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(
      `Could not read the vitest JSON report at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  console.log(
    `${path}: files=${(one.testResults ?? []).length} passed=${one.numPassedTests} failed=${one.numFailedTests} pending=${one.numPendingTests}`,
  );
  report.testResults.push(...(one.testResults ?? []));
  for (const k of /** @type {Count[]} */ ([
    'numPassedTests',
    'numFailedTests',
    'numPendingTests',
    'numTodoTests',
  ])) {
    report[k] += one[k] ?? 0;
  }
}
const files = report.testResults;
const assertions = files.flatMap((f) =>
  (f.assertionResults ?? []).map((a) => ({ file: f.name, ...a })),
);
/** @type {Record<string, number>} */
const histogram = {};
for (const a of assertions) histogram[a.status] = (histogram[a.status] ?? 0) + 1;
console.log(`files=${files.length} tests=${assertions.length} ${JSON.stringify(histogram)}`);
console.log(
  `reported totals: passed=${report.numPassedTests} failed=${report.numFailedTests} pending=${report.numPendingTests} todo=${report.numTodoTests}`,
);
if (assertions.length === 0) {
  console.error('The report contains no tests. A run that collected nothing is not a pass.');
  process.exit(1);
}
const notRun = assertions.filter((a) => a.status !== 'passed' && a.status !== 'failed');
if (notRun.length > 0) {
  console.error(`${notRun.length} test(s) did not run:`);
  for (const a of notRun) console.error(`  [${a.status}] ${a.fullName}  (${a.file})`);
  console.error('');
  console.error('A skipped test is not a passed test. If these are the database-backed');
  console.error('suites, TEST_DATABASE_URL did not reach them and this job is green over');
  console.error('an acceptance test that never executed.');
  process.exit(1);
}
console.log(`Every one of the ${assertions.length} collected tests ran.`);
