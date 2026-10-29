// The build-embedded job points the embedded tests' TMPDIR at a directory its cleanup step removes.
// Node keeps its compile cache under the temp directory unless NODE_COMPILE_CACHE says otherwise,
// and an Nx process that outlives the tests can still be writing it while `rm -rf` runs, which
// failed the job after every test passed ("Directory not empty", #1925 item 18). So the step sets
// NODE_COMPILE_CACHE outside the removed directory, and nothing but the tests writes there.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { workflowJobs } from '../../scripts/ci/workflow-jobs.mjs';

const CI = path.resolve(import.meta.dirname, '../../.github/workflows/ci.yml');

/** Each step of a job as its lines, from one `- name:` (or `- uses:`/`- run:`) to the next. */
function steps(job: readonly { text: string }[]): string[] {
  const found: string[] = [];
  for (const { text } of job) {
    if (/^ {6}- /u.test(text)) found.push(text);
    else if (found.length > 0) found[found.length - 1] += `\n${text}`;
  }
  return found;
}

function envValue(step: string, name: string): string | undefined {
  return new RegExp(`^ {10}${name}: (.+)$`, 'mu').exec(step)?.[1]?.trim();
}

describe('the embedded tests temp directory', () => {
  const job = workflowJobs(readFileSync(CI, 'utf8')).find(({ id }) => id === 'build-embedded');
  if (job === undefined) throw new Error('ci.yml has no build-embedded job');
  const all = steps(job.lines);
  const test = all.find((step) => step.includes('name: Test embedded'));
  const cleanup = all.find((step) => step.includes('rm -rf "$RUNNER_TEMP/embedded-test"'));

  it('keeps the compile cache outside the directory the cleanup removes', () => {
    expect(test).toBeDefined();
    expect(cleanup).toBeDefined();
    const tmpdir = envValue(test ?? '', 'TMPDIR');
    const cache = envValue(test ?? '', 'NODE_COMPILE_CACHE');
    expect(tmpdir).toBe('${{ runner.temp }}/embedded-test');
    expect(cache).toBeDefined();
    expect(`${cache ?? ''}/`.startsWith(`${tmpdir ?? ''}/`)).toBe(false);
  });
});
