/**
 * Every spec of a Playwright JSON report, by title, and whether it passed.
 *
 * @param {{ suites?: unknown[] }} report
 * @returns {{ title: string, ok: boolean }[]}
 */
export function journeyResults(report) {
  /** @type {{ title: string, ok: boolean }[]} */
  const results = [];
  /** @param {import('@playwright/test/reporter').JSONReportSuite} suite */
  const visit = (suite) => {
    for (const spec of suite?.specs ?? [])
      results.push({ title: spec.title, ok: spec.ok === true });
    for (const child of suite?.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  return results;
}

/**
 * Each settled test of a `test-results-reporter.mjs` file, one JSON line each; a line that is not
 * one is refused rather than read as a pass.
 *
 * @param {string} text
 * @returns {{ title: string, status: 'passed' | 'failed' | 'skipped' | 'todo' }[]}
 */
export function testResults(text) {
  const statuses = ['passed', 'failed', 'skipped', 'todo'];
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const value = JSON.parse(line);
      if (typeof value?.title !== 'string' || !statuses.includes(value?.status)) {
        throw new Error(`not a test result: ${line}`);
      }
      return { title: value.title, status: value.status };
    });
}
