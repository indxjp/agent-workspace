/**
 * The static checks (tests/static-checks/vitest.config.ts) are only a gate while something runs
 * them: each `*.docs-check.ts` and `*.policy-check.ts` file is collected by its lane and by no test
 * project, `pnpm docs:check` runs the docs lane, and `pnpm policy:check` — in check:fast — runs the
 * policy lane. A file renamed out of its lane, or a lane dropped from the scripts, fails here.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { collectedFiles } from '../../scripts/policy-check-test-inputs.mjs';
import { testsProjects } from '../projects.mjs';
import { notRun, runStaticChecks, STATIC_CHECK_LANES } from './run.mjs';
import staticChecksConfig from './vitest.config.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const trackedUnderTests = execFileSync('git', ['ls-files', '-z', '--', 'tests'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\0')
  .filter((file) => file !== '');

interface LaneConfig {
  readonly test: { readonly name: string; readonly include: readonly string[] };
}

const lanes = (staticChecksConfig.test?.projects ?? []) as readonly LaneConfig[];

const scripts = (
  JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;

describe('the static-check lanes', () => {
  it('are the lanes the runner accepts, in the same order', () => {
    expect(lanes.map((lane) => lane.test.name)).toEqual(STATIC_CHECK_LANES);
  });

  it.each(STATIC_CHECK_LANES)('collect every tracked *.%s.ts file, and at least one', (lane) => {
    const config = lanes.find((candidate) => candidate.test.name === lane);
    expect(config, lane).toBeDefined();
    const files = trackedUnderTests.filter((file) => file.endsWith(`.${lane}.ts`));
    expect(files.length, `no ${lane} file is tracked`).toBeGreaterThan(0);
    for (const file of files) {
      expect(
        config?.test.include.some((glob) => path.posix.matchesGlob(file, glob)),
        file,
      ).toBe(true);
    }
  });

  it('are collected by no test project, so no test lane runs them a second time', () => {
    const collected = testsProjects({ loadTests: true }).flatMap((project) =>
      collectedFiles(repoRoot, project),
    );
    expect(collected.length).toBeGreaterThan(0);
    expect(collected.filter((file) => /\.(?:docs|policy)-check\.ts$/u.test(file))).toEqual([]);
  });
});

describe('the scripts that run them', () => {
  it('runs the docs lane in docs:check', () => {
    expect(scripts['docs:check']).toContain('node tests/static-checks/run.mjs docs-check');
  });

  it('runs the policy lane as policy:check, in check:fast', () => {
    expect(scripts['policy:check']).toBe('node scripts/policy-check.mjs');
    expect(readFileSync(path.join(repoRoot, 'scripts/policy-check.mjs'), 'utf8')).toContain(
      "runStaticChecks('policy-check', ",
    );
    expect(scripts['check:fast']?.split(' && ')).toContain('pnpm policy:check');
  });

  it('refuses a lane it does not know rather than running nothing', () => {
    expect(() => runStaticChecks('no-such-lane', [], process.env)).toThrow(
      /unknown static-check lane/u,
    );
  });
});

describe('a static check that did not run', () => {
  const report = (...statuses: string[]) => ({
    testResults: [
      {
        assertionResults: statuses.map((status, index) => ({
          status,
          fullName: `check ${String(index)}`,
        })),
      },
    ],
  });

  it('fails the lane when it was skipped or left to do, and passes one that ran', () => {
    expect(notRun(report('passed', 'failed'))).toEqual([]);
    expect(notRun(report('passed', 'skipped', 'todo', 'pending'))).toEqual([
      'skipped: check 1',
      'todo: check 2',
      'pending: check 3',
    ]);
  });

  it('fails the lane when no check ran at all', () => {
    expect(notRun(report())).toEqual(['(no static check ran)']);
    expect(notRun({})).toEqual(['(no static check ran)']);
  });
});
