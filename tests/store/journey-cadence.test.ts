/**
 * R3: the store says when the example apps' browser journeys run, and says it as ci.yml has it. The
 * decision (not a per-PR gate) is in the product spec, whose wording `tests/docs-truth/internal.docs-check.ts`
 * checks against the triggers pinned here; this test pins the workflow and the store's own text.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url).pathname;
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const ci = read('.github/workflows/ci.yml');

/** The lines of the apps-e2e job, up to the next job header. */
function job(name: string): string {
  const lines = ci.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  expect(start, `${name} is a job in ci.yml`).toBeGreaterThan(-1);
  const end = lines.findIndex((line, i) => i > start && /^ {2}[a-z0-9-]+:$/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

/** The `if:` condition of a job, folded onto one line. */
function condition(block: string): string {
  const match = /^ {4}if: >-\n((?: {6}.*\n)+)/m.exec(block);
  expect(match, 'the job has a folded if: condition').not.toBeNull();
  return (match?.[1] ?? '').trim().replace(/\s+/g, ' ');
}

describe('the apps-e2e cadence the store claims', () => {
  const condition_ = condition(job('apps-e2e'));

  it('ci.yml runs the journeys on the nightly schedule, a dispatch, the release gate and ci:full', () => {
    expect(condition_).toContain("github.event_name == 'schedule'");
    expect(condition_).toContain("github.event_name == 'workflow_dispatch'");
    expect(condition_).toContain('inputs.full');
    expect(condition_).toContain("contains(github.event.pull_request.labels.*.name, 'ci:full')");
  });

  it('ci.yml does not run them on every pull request or push', () => {
    expect(condition_).not.toMatch(/github\.event_name == '(pull_request|push)'/);
    expect(condition_).not.toMatch(/^true$/);
  });

  it('the schedule is 17:37 UTC daily, which is 02:37 JST', () => {
    expect(ci).toMatch(/^ {4}- cron: '37 17 \* \* \*'$/m);
  });

  it('the release gate is the tagged-commit call with full: true', () => {
    for (const file of ['publish-packages.yml', 'images.yml']) {
      const caller = read(`.github/workflows/${file}`);
      expect(caller, file).toMatch(/uses: \.\/\.github\/workflows\/ci\.yml/);
      expect(caller, file).toMatch(/full: true/);
    }
  });
});

describe('nothing in the store says the journeys run on every change', () => {
  function files(dir: string): string[] {
    return readdirSync(join(root, dir)).flatMap((name) => {
      const path = join(dir, name);
      if (name === 'node_modules' || name.startsWith('.')) return [];
      return statSync(join(root, path)).isDirectory() ? files(path) : [path];
    });
  }

  /** The few words around each mention, so a failure names the sentence, not the page. */
  const mentions = (text: string): string[] =>
    [...text.matchAll(/.{0,40}(every change|変更のたびに).{0,20}/gi)].map((m) => m[0]);

  it('no store screen or catalog text claims it', () => {
    for (const path of files('examples/store').filter((p) => /\.(tsx?|json|md)$/.test(p))) {
      expect(mentions(read(path)), path).toEqual([]);
    }
  });
});
