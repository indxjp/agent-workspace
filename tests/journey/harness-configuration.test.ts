import { failureOf, HERE, ROOT } from './harness-fixtures.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  JOURNEY_BUDGET_SECONDS,
  JOURNEY_LOOK_CHANGE_BUDGET_SECONDS,
  JOURNEY_TOOL_BUDGET_SECONDS,
  JOURNEY_PORTAL_BUDGET_SECONDS,
  MIN_COMMAND_MS,
  registryOf,
  remainingMs,
  stringMapOf,
  workDirectoryOf,
} from './harness.mjs';
import { PORTAL_CHECKS_MS } from './run.mjs';

describe('the run configuration', () => {
  it('regression: a deadline nearly used up names the variable, not a killed command', () => {
    expect(failureOf(() => remainingMs(1_001, 1_000, 'JOURNEY_PREPARE_TIMEOUT_MS')).message).toBe(
      'the run ran out of JOURNEY_PREPARE_TIMEOUT_MS',
    );
    expect(remainingMs(1_000 + MIN_COMMAND_MS, 1_000, 'X')).toBe(MIN_COMMAND_MS);
  });

  it('regression: a blank JOURNEY_WORK_DIR is unset, never the current directory', () => {
    expect(workDirectoryOf(undefined)).toBeNull();
    expect(workDirectoryOf('')).toBeNull();
    expect(workDirectoryOf('  ')).toBeNull();
    expect(workDirectoryOf('/tmp/journey')).toBe('/tmp/journey');
  });

  it('JOURNEY_REGISTRY: unset or blank keeps Verdaccio; a URL is the registry; anything else stops (#608)', () => {
    expect(registryOf(undefined)).toBeNull();
    expect(registryOf(' ')).toBeNull();
    expect(registryOf('https://registry.npmjs.org')).toBe('https://registry.npmjs.org/');
    expect(registryOf(' https://registry.npmjs.org/ ')).toBe('https://registry.npmjs.org/');
    for (const value of ['registry.npmjs.org', 'file:///tmp', 'https://user:token@example.com/']) {
      expect(failureOf(() => registryOf(value)).message).toBe(
        'JOURNEY_REGISTRY must be an http(s) registry URL without credentials',
      );
    }
  });

  it('regression: writes the registry token under its own temporary directory, removed in finally', () => {
    const source = readFileSync(path.join(HERE, 'run.mjs'), 'utf8');
    expect(source).toContain("path.join(secrets, 'publish.npmrc')");
    expect(source).not.toContain("path.join(work, 'publish.npmrc')");
    expect(source).toMatch(
      /finally \{\n\s+rmSync\(secrets, \{ recursive: true, force: true \}\);/u,
    );
  });

  it('regression: reads a snapshot back only as a flat string map', () => {
    expect(stringMapOf('{"a.ts":"00","b/c.ts":"ff"}', 'snapshot')).toEqual({
      'a.ts': '00',
      'b/c.ts': 'ff',
    });
    expect(failureOf(() => stringMapOf('not json', 'snapshot')).message).toBe(
      'snapshot printed no JSON',
    );
    expect(failureOf(() => stringMapOf('["a"]', 'snapshot')).message).toBe(
      'snapshot printed no JSON object',
    );
    expect(failureOf(() => stringMapOf('null', 'snapshot')).message).toBe(
      'snapshot printed no JSON object',
    );
    expect(failureOf(() => stringMapOf('{"a.ts":{"x":1}}', 'snapshot')).message).toBe(
      'snapshot: a.ts is not a string',
    );
  });
});

const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

/** One top-level job of ci.yml, split the way scripts/check-workflows.mjs splits it. */
function jobBlock(jobId: string): string {
  const lines = ci.split(/\r?\n/u);
  const start = lines.indexOf(`  ${jobId}:`);
  if (start < 0) throw new Error(`ci.yml has no ${jobId} job`);
  const nextJob = lines.findIndex(
    (line, index) => index > start && /^ {2}[a-zA-Z0-9_-]+:\s*$/u.test(line),
  );
  return lines.slice(start, nextJob < 0 ? undefined : nextJob).join('\n');
}

const workflow = jobBlock('journey-e2e');
const scopePattern = /^ {10}pattern='([^']+)'$/mu.exec(workflow)?.[1];
if (scopePattern === undefined) {
  throw new Error("the journey-e2e job has no scope step line `pattern='…'`");
}
const scope = new RegExp(scopePattern, 'u');

/** Whether a pull request touching this file runs the journey (the scope step's grep -E). */
function filtered(file: string): boolean {
  return scope.test(file);
}

/** Every repository file run.mjs loads through relative imports, directly or not. */
function localImports(entry: string): string[] {
  const seen = new Set<string>();
  const pending = [entry];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    const source = readFileSync(path.join(ROOT, next), 'utf8');
    for (const match of source.matchAll(/^import [^;]*? from '(\.{1,2}\/[^']+)';$/gmsu)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      pending.push(path.posix.join(path.posix.dirname(next), specifier));
    }
  }
  return [...seen].sort();
}

it('runs on a change to any file the journey imports or builds with', () => {
  const imported = localImports('tests/journey/run.mjs');
  expect(imported).toContain('tests/generated-project/images.mjs');
  expect(imported.filter((file) => !filtered(file))).toEqual([]);
  for (const file of [
    '.github/actions/nx-remote-cache/action.yml',
    '.github/actions/workspace-build/action.yml',
    '.github/actions/free-disk/action.yml',
    'scripts/ci/nx.sh',
    'nx.json',
    'tsconfig.json',
    'tsconfig.root.json',
    'playwright.journey.config.mjs',
    '.github/workflows/ci.yml',
  ]) {
    expect(filtered(file)).toBe(true);
  }
  expect(filtered('docs/operations/ci.md')).toBe(false);
  // The packages come built from ci.yml's `build` job; the journey job never runs an Nx build.
  expect(workflow).toContain('uses: ./.github/actions/workspace-build');
  expect(workflow).not.toContain('scripts/ci/nx.sh');
  expect(workflow).toContain('run: node tests/journey/run.mjs');
});

it('#514: is a ci-success need, filtered in a step, never an unrequired workflow of its own', () => {
  expect(existsSync(path.join(ROOT, '.github', 'workflows', 'journey-e2e.yml'))).toBe(false);
  // One line, or wrapped by Prettier once the list passes the print width.
  const needs = /^ {4}needs:\s*\[([^\]]*)\]$/mu.exec(jobBlock('ci-success'))?.[1] ?? '';
  expect(needs.split(',').map((job) => job.trim())).toContain('journey-e2e');
  // Only the heavy-tier condition (ci.yml, COST) may skip the job.
  expect(workflow).not.toMatch(/^ {4}if:(?! >-\r?\n {6}github\.event_name == 'schedule')/mu);
  expect(workflow).toContain('name: developer journey · ${{ matrix.part }}');
});

it('uploads evidence only from where run.mjs writes it', () => {
  const uploads = [...workflow.matchAll(/^ {10}path: (.+)$/gmu)].map((match) => match[1]);
  expect(uploads).toEqual([
    '${{ runner.temp }}/journey/journey-timings.json',
    '${{ runner.temp }}/journey-first-hour/first-hour-timings.json',
    '${{ runner.temp }}/journey/evidence/',
  ]);
});

it('fits run.mjs caps inside the step timeout, and every step inside the job timeout', () => {
  const numberOf = (pattern: RegExp): number => Number(pattern.exec(workflow)?.[1] ?? Number.NaN);
  const job = numberOf(/^ {4}timeout-minutes: (\d+)$/mu);
  const install = numberOf(/- name: Install\n {8}timeout-minutes: (\d+)/u);
  const journey = numberOf(
    /- name: Run the developer journey on a clean container\n {8}timeout-minutes: (\d+)/u,
  );
  const prepareMs = numberOf(/JOURNEY_PREPARE_TIMEOUT_MS: '(\d+)'/u);
  const checksMs = numberOf(/JOURNEY_CHECKS_TIMEOUT_MS: '(\d+)'/u);
  for (const value of [job, install, journey, prepareMs, checksMs]) {
    expect(Number.isSafeInteger(value)).toBe(true);
  }
  // Each timed block: its budget plus run.mjs's one minute to report it — B1, then S2-08's B2,
  // B3b and B3a, and J1 (issue #1510) — two untimed checks caps, B1's and the ceiling and
  // secret checks', and J1's console check cap.
  const blockMs = (seconds: number) => (seconds + 60) * 1000;
  const timedMs =
    blockMs(JOURNEY_BUDGET_SECONDS) +
    blockMs(JOURNEY_LOOK_CHANGE_BUDGET_SECONDS) +
    2 * blockMs(JOURNEY_TOOL_BUDGET_SECONDS) +
    blockMs(JOURNEY_PORTAL_BUDGET_SECONDS);
  const cleanupMs = 3 * 60_000;
  expect(prepareMs + timedMs + 2 * checksMs + PORTAL_CHECKS_MS + cleanupMs).toBeLessThanOrEqual(
    journey * 60_000,
  );
  const setupAndUploads = 5;
  const firstHour = numberOf(/- name: Time the first hour\n(?:.*\n)*? {8}timeout-minutes: (\d+)/u);
  expect(Number.isSafeInteger(firstHour)).toBe(true);
  // First-hour step: prepare, the exec cap (the spec's own test timeout plus a minute), the read, cleanup.
  const execMinutes = Number(
    /FIRST_HOUR_EXEC_MS = (\d+) \* 60_000/u.exec(
      readFileSync(path.join(HERE, 'run.mjs'), 'utf8'),
    )?.[1],
  );
  const specMinutes = Number(
    /test\.setTimeout\((\d+) \* 60_000\)/u.exec(
      readFileSync(path.join(HERE, 'first-hour.e2e.mjs'), 'utf8'),
    )?.[1],
  );
  expect(execMinutes).toBeGreaterThan(specMinutes);
  expect(prepareMs / 60_000 + execMinutes + 1 + 3).toBeLessThanOrEqual(firstHour);
  expect(install + journey + firstHour + setupAndUploads).toBeLessThanOrEqual(job);
});

describe('the first-hour code tool (issue #693)', () => {
  it('declares its run file project-relative, as the tool host resolves it', () => {
    const spec = readFileSync(path.join(HERE, 'first-hour-steps.mjs'), 'utf8');
    const run = /run: '\.\/(tools\/[^']+\.run\.ts)'/u.exec(spec)?.[1];
    expect(run).toBeDefined();
    const writtenFiles = [...spec.matchAll(/writeProjectFile\(\s*cwd,\s*'([^']+)'/gu)].map(
      (match) => match[1],
    );
    expect(writtenFiles).toContain(run);
  });
});
