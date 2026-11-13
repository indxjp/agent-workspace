import { rm } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';

import { IDS, json, runCli, stdoutJson, tempDirectory, tempFile } from '../testing.js';

import './eval.fixture.test-support.js';

import {
  ADVANCE_PATH,
  evaluation,
  EVALUATION_ID,
  root,
  route,
  RUNS_PATH,
} from './eval.fixture.test-support.js';

import {
  advancing,
  CASES,
  dropped,
  failing,
  file,
  olderServer,
  posted,
  resource,
  RUN_ID,
} from './eval.scenarios.test-support.js';
describe('aw eval run', () => {
  describe('a file of more than 20 cases', () => {
    it('creates a run and advances it until it completes, reporting progress', async () => {
      const cwd = await tempDirectory();
      await tempFile(cwd, 'evals/Summariser.yaml', file);
      const done = [10, 20, 25];
      const run = await runCli(['eval', 'run', 'Summariser'], {
        cwd,
        route: (request) => {
          const { pathname } = request.url;
          if (pathname === `/api/agents/${IDS.agent}/evaluation-runs`)
            return json(202, resource(0));
          if (pathname === `/api/agents/${IDS.agent}/evaluation-advance`) {
            return json(200, resource(done.shift() ?? CASES));
          }
          return route(() => json(500, {}))(request);
        },
      });
      await rm(cwd, { recursive: true, force: true });
      expect(run.code).toBe(EXIT_CODE.problem);
      const paths = run.calls
        .filter((call) => call.method === 'POST')
        .map((call) => call.url.pathname);
      expect(paths).toEqual([
        `/api/agents/${IDS.agent}/evaluation-runs`,
        ...Array.from({ length: 3 }, () => `/api/agents/${IDS.agent}/evaluation-advance`),
      ]);
      expect(
        run.calls.find((call) => call.url.pathname.endsWith('evaluation-advance'))?.json,
      ).toEqual({
        evaluationId: RUN_ID,
      });
      expect(run.stderr).toContain('Summariser: 10/25 cases');
      expect(run.stderr).toContain('Summariser: 25/25 cases');
      expect(run.stdout).toContain('Summariser v7 (local) · 25 cases');
      expect(run.stdout).toContain('  24/25 passed');
      expect(run.stderr).toContain('1 of 25 cases failed');
    });

    it('prints the run id when an advance fails, and leaves the run on the server', async () => {
      const cwd = await tempDirectory();
      await tempFile(cwd, 'evals/Summariser.yaml', file);
      const run = await runCli(['eval', 'run', 'Summariser'], {
        cwd,
        route: (request) => {
          const { pathname } = request.url;
          if (pathname === `/api/agents/${IDS.agent}/evaluation-runs`)
            return json(202, resource(0));
          if (pathname === `/api/agents/${IDS.agent}/evaluation-advance`) {
            return json(409, { error: { code: 'evaluation_run_busy', message: 'Busy.' } });
          }
          return route(() => json(500, {}))(request);
        },
      });
      await rm(cwd, { recursive: true, force: true });
      expect(run.code).toBe(EXIT_CODE.problem);
      expect(run.stderr).toContain(`evaluation ${RUN_ID} stopped at 0/25 cases`);
      expect(run.stderr).toContain('evaluation_run_busy');
    });

    it('waits out a busy run and goes on advancing it', async () => {
      const cwd = await tempDirectory();
      await tempFile(cwd, 'evals/Summariser.yaml', file);
      let advances = 0;
      const run = await runCli(['eval', 'run', 'Summariser', '--json'], {
        cwd,
        route: (request) => {
          const { pathname } = request.url;
          if (pathname === `/api/agents/${IDS.agent}/evaluation-runs`)
            return json(202, resource(0));
          if (pathname === `/api/agents/${IDS.agent}/evaluation-advance`) {
            advances += 1;
            return advances === 1
              ? json(409, { error: { code: 'evaluation_run_busy', message: 'Busy.' } })
              : json(200, resource(CASES));
          }
          return route(() => json(500, {}))(request);
        },
      });
      await rm(cwd, { recursive: true, force: true });
      expect(advances).toBe(2);
      expect(run.stderr).not.toContain('stopped at');
      // `--json` has the shape of a synchronous evaluation, with no run status.
      const evaluation = stdoutJson(run);
      expect(evaluation).toMatchObject({ id: RUN_ID, passed: 24, total: CASES });
      expect(evaluation).not.toHaveProperty('status');
    });

    it('also uses a run for 20 cases or fewer, never the one long synchronous request', async () => {
      const run = await runCli(['eval', 'run', 'Summariser'], { cwd: root, route: route(failing) });
      const paths = run.calls
        .filter((call) => call.method === 'POST')
        .map((call) => call.url.pathname);
      expect(paths).toEqual([`/api/agents/${IDS.agent}/evaluation-runs`]);
    });

    it.each([1, 3])('goes on advancing after %i dropped connection(s)', async (drops) => {
      const cwd = await tempDirectory();
      await tempFile(cwd, 'evals/Summariser.yaml', file);
      const run = await runCli(['eval', 'run', 'Summariser', '--json'], {
        cwd,
        route: advancing(Array.from({ length: drops }, () => dropped)),
      });
      await rm(cwd, { recursive: true, force: true });
      expect(run.code).toBe(EXIT_CODE.problem);
      expect(run.stderr).not.toContain('stopped at');
      expect(stdoutJson(run)).toMatchObject({ id: RUN_ID, total: CASES });
      expect(
        run.calls.filter((call) => call.url.pathname.endsWith('evaluation-advance')),
      ).toHaveLength(drops + 1);
    });

    it('waits out a whole lease again after each dropped connection', async () => {
      const cwd = await tempDirectory();
      await tempFile(cwd, 'evals/Summariser.yaml', file);
      const busy = (): Response =>
        json(409, { error: { code: 'evaluation_run_busy', message: 'Busy.' } });
      const leaseHeld = Array.from({ length: 40 }, () => busy);
      const run = await runCli(['eval', 'run', 'Summariser', '--json'], {
        cwd,
        route: advancing([dropped, ...leaseHeld, dropped, ...leaseHeld]),
      });
      await rm(cwd, { recursive: true, force: true });
      expect(run.stderr).not.toContain('evaluation_run_busy');
      expect(stdoutJson(run)).toMatchObject({ id: RUN_ID, total: CASES });
      expect(
        run.calls.filter((call) => call.url.pathname.endsWith('evaluation-advance')),
      ).toHaveLength(83);
    });

    it('gives up after more dropped connections than it retries, printing the run id', async () => {
      const cwd = await tempDirectory();
      await tempFile(cwd, 'evals/Summariser.yaml', file);
      const run = await runCli(['eval', 'run', 'Summariser'], {
        cwd,
        route: advancing(Array.from({ length: 10 }, () => dropped)),
      });
      await rm(cwd, { recursive: true, force: true });
      expect(run.code).not.toBe(EXIT_CODE.ok);
      expect(run.stderr).toContain(`evaluation ${RUN_ID} stopped at 0/25 cases`);
      expect(
        run.calls.filter((call) => call.url.pathname.endsWith('evaluation-advance')),
      ).toHaveLength(4);
    });

    it('does not retry the request that creates the run', async () => {
      const run = await runCli(['eval', 'run', 'Summariser'], {
        cwd: root,
        route: (request) =>
          request.url.pathname.endsWith('evaluation-runs') ? dropped() : route(failing)(request),
      });
      expect(run.code).not.toBe(EXIT_CODE.ok);
      expect(
        run.calls.filter((call) => call.url.pathname.endsWith('evaluation-runs')),
      ).toHaveLength(1);
    });

    it('falls back to the synchronous evaluation on a server without evaluation runs', async () => {
      const run = await runCli(['eval', 'run', 'Summariser'], { cwd: root, route: olderServer });
      expect(run.code).toBe(EXIT_CODE.ok);
      expect(posted(run)).toEqual([
        `/api/agents/${IDS.agent}/evaluation-runs`,
        `/api/agents/${IDS.agent}/evaluations`,
      ]);
      expect(run.stdout).toContain(`  2/2 passed · evaluation ${EVALUATION_ID}`);
    });

    it('does not fall back for more cases than one synchronous evaluation takes', async () => {
      const cwd = await tempDirectory();
      await tempFile(cwd, 'evals/Summariser.yaml', file);
      const run = await runCli(['eval', 'run', 'Summariser'], { cwd, route: olderServer });
      await rm(cwd, { recursive: true, force: true });
      expect(run.code).not.toBe(EXIT_CODE.ok);
      expect(posted(run)).toEqual([`/api/agents/${IDS.agent}/evaluation-runs`]);
    });

    it('does not fall back on a 404 the evaluation-run route itself answers', async () => {
      const run = await runCli(['eval', 'run', 'Summariser'], {
        cwd: root,
        route: (request) =>
          request.url.pathname.endsWith('evaluation-runs')
            ? json(404, { error: { code: 'agent_not_found', message: 'No such agent.' } })
            : olderServer(request),
      });
      expect(run.code).not.toBe(EXIT_CODE.ok);
      expect(run.stderr).toContain('agent_not_found');
      expect(posted(run)).toEqual([`/api/agents/${IDS.agent}/evaluation-runs`]);
    });
  });
  describe('a file of 20 cases or fewer', () => {
    const resource = (done: number) => ({
      ...evaluation(7, [[], []]),
      id: RUN_ID,
      status: done === 2 ? 'completed' : 'running',
      results: evaluation(7, [[], []]).results.slice(0, done),
    });

    it('advances a case at a time, so each case is a separate request with its own deadline', async () => {
      const done = [1, 2];
      const run = await runCli(['eval', 'run', 'Summariser'], {
        cwd: root,
        route: (request) => {
          if (request.url.pathname === RUNS_PATH) return json(202, resource(0));
          if (request.url.pathname === ADVANCE_PATH) return json(200, resource(done.shift() ?? 2));
          return route(() => json(500, {}))(request);
        },
      });
      expect(run.code).toBe(EXIT_CODE.ok);
      expect(run.calls.filter((call) => call.url.pathname === ADVANCE_PATH)).toHaveLength(2);
      expect(run.stderr).toContain('Summariser: 1/2 cases');
      expect(run.stderr).toContain('Summariser: 2/2 cases');
      expect(run.stdout).toContain('  2/2 passed');
    });
  });
});
