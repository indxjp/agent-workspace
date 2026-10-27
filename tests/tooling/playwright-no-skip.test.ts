// scripts/ci/playwright-no-skip.mjs (audit F-14): a skipped or flaky browser test fails the lane.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const script = path.resolve('scripts/ci/playwright-no-skip.mjs');

/** A Playwright JSON report with one nested suite holding a test of each given status. */
const report = (...statuses: string[]) => ({
  suites: [
    {
      title: 'a.spec.mjs',
      specs: [],
      suites: [
        {
          title: 'group',
          specs: statuses.map((status, i) => ({
            title: `test ${i}`,
            tests: [{ projectName: 'chromium', status }],
          })),
        },
      ],
    },
  ],
});

const run = (json: unknown) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pw-no-skip-'));
  try {
    const file = path.join(dir, 'results.json');
    writeFileSync(file, JSON.stringify(json));
    return spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('playwright no-skip gate', () => {
  it('passes when every test passed', () => {
    expect(run(report('expected', 'expected')).status).toBe(0);
  });

  it('fails on a skipped test and names it', () => {
    const result = run(report('expected', 'skipped'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('test 1');
  });

  it('fails on a flaky test (passed only on retry)', () => {
    expect(run(report('expected', 'flaky')).status).toBe(1);
  });

  it('fails on an unexpected (failed) test', () => {
    expect(run(report('unexpected')).status).toBe(1);
  });

  it('fails on a report with no tests', () => {
    expect(run({ suites: [] }).status).toBe(1);
  });

  it('fails when the report is missing', () => {
    const result = spawnSync(
      process.execPath,
      [script, path.join(tmpdir(), 'no-such-report.json')],
      {
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(1);
  });
});
