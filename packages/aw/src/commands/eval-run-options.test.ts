import { readFile, rm } from 'node:fs/promises';

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';

import { json, runCli, stdoutJson, tempDirectory, tempFile } from '../testing.js';

import './eval.fixture.test-support.js';

import { EVALS, evaluation, EVALUATION_ID, root, route } from './eval.fixture.test-support.js';

import { BASELINE_ID, failing, withBaseline } from './eval.scenarios.test-support.js';
describe('aw eval run', () => {
  it('is the same command as aw eval', async () => {
    const bare = await runCli(['eval', 'Summariser'], { cwd: root, route: route(failing) });
    const named = await runCli(['eval', 'run', 'Summariser'], { cwd: root, route: route(failing) });
    expect(named.code).toBe(EXIT_CODE.problem);
    expect(named.stdout).toBe(bare.stdout);
    expect(named.stderr).toBe(bare.stderr);
  });
  describe('--min-score', () => {
    it('exits 0 when the score meets it, though a case failed', async () => {
      const run = await runCli(['eval', 'run', 'Summariser', '--min-score', '0.5'], {
        cwd: root,
        route: route(failing),
      });
      expect(run.code).toBe(EXIT_CODE.ok);
      expect(run.stdout).toContain('  1/2 passed');
    });

    it('exits 1 naming the score when it falls short', async () => {
      const run = await runCli(['eval', 'run', 'Summariser', '--min-score', '0.8'], {
        cwd: root,
        route: route(failing),
      });
      expect(run.code).toBe(EXIT_CODE.problem);
      expect(run.stderr).toContain('score 0.5 is below --min-score 0.8');
    });

    it.each(['1.5', '-1', 'high', ''])('exits 2 for %j, before any request', async (raw) => {
      const run = await runCli(['eval', 'run', 'Summariser', '--min-score', raw], {
        cwd: root,
        route: route(failing),
      });
      expect(run.code).toBe(EXIT_CODE.usage);
      expect(run.stderr).toContain('--min-score must be a number from 0 to 1');
      expect(run.calls).toHaveLength(0);
    });
  });
  describe('--junit', () => {
    it('writes the report even when a case failed, with the XML escaped', async () => {
      const cwd = await tempDirectory();
      await tempFile(cwd, 'evals/Summariser.yaml', EVALS);
      const answer = evaluation(7, [[], ['notContains: "<refund>" & more']]);
      const run = await runCli(['eval', 'run', 'Summariser', '--junit', 'out/junit.xml'], {
        cwd,
        route: route(() => json(201, answer)),
      });
      const xml = await readFile(path.join(cwd, 'out/junit.xml'), 'utf8').catch(() => '');
      await rm(cwd, { recursive: true, force: true });
      expect(run.code).toBe(EXIT_CODE.problem);
      expect(xml).toContain('<testsuite name="Summariser" tests="2" failures="1"');
      expect(xml).toContain('<testcase classname="Summariser" name="order status"/>');
      expect(xml).toContain(
        '<failure message="notContains: &quot;&lt;refund&gt;&quot; &amp; more">',
      );
    });
  });
  describe('--baseline', () => {
    it('prints the per-case difference and leaves the exit code to the failures', async () => {
      const run = await runCli(['eval', 'run', 'Summariser', '--baseline', BASELINE_ID], {
        cwd: root,
        route: withBaseline(),
      });
      expect(run.code).toBe(EXIT_CODE.problem);
      expect(run.stdout).toContain(`baseline ${BASELINE_ID} · v6 · 2/2 passed → 1/2`);
      expect(run.stdout).toContain('  regressed  no refund promises');
    });

    it('adds a baseline key to --json output', async () => {
      const run = await runCli(['eval', 'run', 'Summariser', '--baseline', BASELINE_ID, '--json'], {
        cwd: root,
        route: withBaseline(),
      });
      expect(stdoutJson(run)).toMatchObject({
        id: EVALUATION_ID,
        baseline: { baseline: BASELINE_ID, regressed: ['no refund promises'], fixed: [] },
      });
    });

    it('exits 1 before evaluating when the baseline is unknown or still running', async () => {
      const unknown = await runCli(['eval', 'run', 'Summariser', '--baseline', 'nope'], {
        cwd: root,
        route: withBaseline(),
      });
      expect(unknown.code).toBe(EXIT_CODE.problem);
      expect(unknown.stderr).toContain('evaluation_not_found');
      const running = await runCli(['eval', 'run', 'Summariser', '--baseline', BASELINE_ID], {
        cwd: root,
        route: withBaseline('running'),
      });
      expect(running.code).toBe(EXIT_CODE.problem);
      expect(running.stderr).toContain(`baseline ${BASELINE_ID} has not completed`);
      expect([...unknown.calls, ...running.calls].some((call) => call.method === 'POST')).toBe(
        false,
      );
    });

    it('exits 2 with no agent named and several evals files, before any request', async () => {
      const cwd = await tempDirectory();
      await tempFile(cwd, 'evals/Summariser.yaml', EVALS);
      await tempFile(cwd, 'evals/Other.yaml', EVALS);
      const run = await runCli(['eval', 'run', '--baseline', BASELINE_ID], {
        cwd,
        route: withBaseline(),
      });
      await rm(cwd, { recursive: true, force: true });
      expect(run.code).toBe(EXIT_CODE.usage);
      expect(run.stderr).toContain('--baseline compares one agent');
      expect(run.calls).toHaveLength(0);
    });
  });
});
