import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const script = path.join(process.cwd(), 'scripts/ci/vitest-no-skip.mjs');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const report = {
  numPassedTests: 1,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  testResults: [{ name: 'a.test.ts', assertionResults: [{ status: 'passed', fullName: 'a' }] }],
};

function run(cwd: string): string {
  return execFileSync(process.execPath, [script], { cwd, encoding: 'utf8' });
}

describe('the no-skip gate finds every project report', () => {
  // A run that only touched a package missing from a hard-coded list failed with "no report".
  it('reads the report of a package nobody listed', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'aw-no-skip-'));
    temporaryRoots.push(root);
    await mkdir(path.join(root, 'packages/brand-new'), { recursive: true });
    await writeFile(
      path.join(root, 'packages/brand-new/.vitest-report.json'),
      JSON.stringify(report),
    );
    expect(run(root)).toContain('Every one of the 1 collected tests ran.');
  });

  it('still fails when no report exists', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'aw-no-skip-'));
    temporaryRoots.push(root);
    expect(() => run(root)).toThrow();
  });
});
