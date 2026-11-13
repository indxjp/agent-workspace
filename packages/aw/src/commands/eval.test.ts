import { rm } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';

import {
  FIXTURES,
  IDS,
  json,
  runCli,
  runFixture,
  stdoutJson,
  tempDirectory,
  tempFile,
  type Route,
} from '../testing.js';

import './eval.fixture.test-support.js';

import {
  empty,
  EVALS,
  evaluation,
  EVALUATION_ID,
  LIST,
  root,
  route,
  RUNS_PATH,
} from './eval.fixture.test-support.js';

import { twoAgents } from './eval.scenarios.test-support.js';
describe('aw eval', () => {
  it("posts the file's cases against local's version, prints the table and exits 0", async () => {
    const run = await runCli(['eval', 'Summariser'], {
      cwd: root,
      route: route(() => json(201, evaluation(7, [[], []]))),
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    const posted = run.calls.find((call) => call.url.pathname === RUNS_PATH);
    expect(posted?.json).toMatchObject({ version: 7, cases: [{ name: 'order status' }, {}] });
    expect(run.stdout).toContain('order status');
    expect(run.stdout).toContain('Summariser v7 (local) · 2 cases');
    expect(run.stdout).toContain(`  2/2 passed · evaluation ${EVALUATION_ID}`);
  });

  it('takes the version from the second positional and the agent from the only file', async () => {
    const run = await runCli(['eval', 'Summariser', '3'], {
      cwd: root,
      route: route(() => json(201, evaluation(3, [[], []]))),
    });
    expect(run.calls.find((call) => call.method === 'POST')?.json).toMatchObject({ version: 3 });
    const sole = await runCli(['eval', '--json'], {
      cwd: root,
      route: route(() => json(201, evaluation(7, [[], []]))),
    });
    expect(sole.code).toBe(EXIT_CODE.ok);
    expect(stdoutJson(sole)).toMatchObject([{ id: EVALUATION_ID, score: 1 }]);
    const named = await runCli(['eval', 'Summariser', '--json'], {
      cwd: root,
      route: route(() => json(201, evaluation(7, [[], []]))),
    });
    expect(stdoutJson(named)).toMatchObject({ id: EVALUATION_ID, score: 1 });
  });

  it('with several evals files and no agent, runs each on its draft, a block each, tallied together', async () => {
    const run = await twoAgents(['eval'], ['Other']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout.indexOf('Other v7 (local) · 2 cases')).toBeGreaterThanOrEqual(0);
    expect(run.stdout.indexOf('Other v7 (local) · 2 cases')).toBeLessThan(
      run.stdout.indexOf('Summariser v7 (local) · 2 cases'),
    );
    expect(run.stderr).toContain('1 of 4 cases failed');
    const json = await twoAgents(['eval', '--json'], ['Other']);
    expect(stdoutJson(json)).toHaveLength(2);
  });

  it('stops before creating any evaluation when an evals file names an unknown agent', async () => {
    const run = await twoAgents(['eval', '--json'], []);
    expect(run.code).not.toBe(EXIT_CODE.ok);
    expect(run.stderr).toContain('no agent named "Other"');
    expect(run.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('prints a line per case and exits 1 when a case fails', async () => {
    const run = await runCli(['eval', 'Summariser'], {
      cwd: root,
      route: route(() => json(201, evaluation(7, [[], ['notContains: "refund"']]))),
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toContain('  ✗ no refund promises   notContains: "refund"');
    expect(run.stdout).toContain('  ✓ order status\n');
    expect(run.stdout).toContain('  1/2 passed');
    expect(run.stderr).toContain('1 of 2 cases failed');
    expect(run.stderr).not.toContain('fix:');
  });

  // Issue #736: a judge failure code reads as a sentence with a next step; --json keeps the code.
  it.each(['judge_unparseable', 'judge_unavailable'])(
    'explains %s in the text output',
    async (code) => {
      const answer = () => json(201, evaluation(7, [[code], []]));
      const run = await runCli(['eval', 'Summariser'], { cwd: root, route: route(answer) });
      expect(run.code).toBe(EXIT_CODE.problem);
      expect(run.stdout).toMatch(
        /✗ order status {3}judge: .*Retry, or check the model connection\./u,
      );
      expect(run.stdout).not.toContain(code);
      const raw = await runCli(['eval', 'Summariser', '--json'], {
        cwd: root,
        route: route(answer),
      });
      expect(stdoutJson(raw)).toMatchObject({ results: [{ failures: [code] }, {}] });
    },
  );
  describe('a case that only reports the run status', () => {
    const HOP = 'The runtime could not be reached.';

    /** The evaluation answer, and `runs` for GET /api/runs/:id. */
    function withRuns(
      failures: readonly (readonly string[])[],
      runs: (request: Parameters<Route>[0]) => Response,
    ) {
      const evaluations = route(() => json(201, evaluation(7, failures)));
      return (request: Parameters<Route>[0]) =>
        request.url.pathname === `/api/runs/${IDS.run}` ? runs(request) : evaluations(request);
    }

    it('prints the run id and its public error under the case', async () => {
      const run = await runCli(['eval', 'Summariser'], {
        cwd: root,
        route: withRuns([['run_failed'], []], () =>
          json(200, { run: { ...runFixture('failed'), error: `${HOP}\u001b[31m` } }),
        ),
      });
      expect(run.code).toBe(EXIT_CODE.problem);
      expect(run.stdout).toContain(
        `  ✗ order status   run_failed\n      run ${IDS.run}: ${HOP} [31m\n`,
      );
      expect(run.stdout).not.toContain('\u001b');
      expect(run.calls.filter((call) => call.url.pathname.startsWith('/api/runs/'))).toHaveLength(
        1,
      );
    });

    it('does not fetch the run for a coded or content failure', async () => {
      const run = await runCli(['eval', 'Summariser'], {
        cwd: root,
        route: withRuns([['model_credential_rejected'], ['notContains: "refund"']], () =>
          json(500, { error: { code: 'unexpected', message: 'must not be called' } }),
        ),
      });
      expect(run.calls.some((call) => call.url.pathname.startsWith('/api/runs/'))).toBe(false);
      expect(run.stdout).not.toContain('      run ');
    });

    it('does not fetch a run for a case without a run id', async () => {
      const body = evaluation(7, [['run_failed'], []]);
      const run = await runCli(['eval', 'Summariser'], {
        cwd: root,
        route: route(() =>
          json(201, {
            ...body,
            results: body.results.map((result) => ({ ...result, runId: null })),
          }),
        ),
      });
      expect(run.code).toBe(EXIT_CODE.problem);
      expect(run.calls.some((call) => call.url.pathname.startsWith('/api/runs/'))).toBe(false);
      expect(run.stdout).not.toContain('      run ');
    });

    it('keeps the case line and the exit code when the run cannot be fetched', async () => {
      const run = await runCli(['eval', 'Summariser'], {
        cwd: root,
        route: withRuns([['run_failed'], []], () =>
          json(404, { error: { code: 'not_found', message: 'gone' } }),
        ),
      });
      expect(run.code).toBe(EXIT_CODE.problem);
      expect(run.stdout).toContain('  ✗ order status   run_failed\n');
      expect(run.stdout).not.toContain('      run ');
      expect(run.stderr).toContain('1 of 2 cases failed');
    });

    it('leaves --json output as the evaluation, without fetching runs', async () => {
      const run = await runCli(['eval', 'Summariser', '--json'], {
        cwd: root,
        route: withRuns([['run_failed'], []], () => json(200, { run: runFixture('failed') })),
      });
      expect(stdoutJson(run)).toEqual(evaluation(7, [['run_failed'], []]));
      expect(run.calls.some((call) => call.url.pathname.startsWith('/api/runs/'))).toBe(false);
    });
  });

  // Issue #661: a case the model key failed names the code and says how to fix it.
  it('adds the model-key fix line when a case failed on the key', async () => {
    const run = await runCli(['eval', 'Summariser'], {
      cwd: root,
      route: route(() => json(201, evaluation(7, [['model_credential_rejected'], []]))),
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toContain('  ✗ order status   model_credential_rejected');
    expect(run.stderr).toContain(
      'error: 1 of 2 cases failed\nfix: on aw dev, set ANTHROPIC_API_KEY to a valid Anthropic key and restart aw dev;',
    );
  });

  it('adds the reachability fix line, not the key, when a case could not connect', async () => {
    const run = await runCli(['eval', 'Summariser'], {
      cwd: root,
      route: route(() => json(201, evaluation(7, [['model_connection_failed'], []]))),
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain(
      "error: 1 of 2 cases failed\nfix: check the model connection's base URL",
    );
    expect(run.stderr).not.toContain('ANTHROPIC_API_KEY');
  });

  it('exits 2 naming the file when there is no evals file', async () => {
    const run = await runCli(['eval', 'Summariser'], {
      cwd: empty,
      route: route(() => json(500, {})),
    });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('evals/Summariser.yaml');
    expect(run.calls).toHaveLength(0);
  });

  it.each([
    ['a path-like agent', ['eval', '../Summariser'], 'is not a file name in evals/'],
    ['no evals directory and no agent', ['eval'], 'missing <agent>'],
  ])('exits 2 for %s, before any request', async (_label, argv, message) => {
    const cwd = await tempDirectory();
    const run = await runCli(argv, { cwd, route: route(() => json(500, {})) });
    await rm(cwd, { recursive: true, force: true });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain(message);
    expect(run.calls).toHaveLength(0);
  });

  it.each([
    ['no agent by that name', { agents: [] }, LIST, 'no agent named "Summariser"'],
    [
      'local pointing at no version',
      { agents: [FIXTURES.agent] },
      { items: [], pointers: [], materialised: null },
      'local points at no version yet',
    ],
  ])('exits 1 for %s, posting nothing', async (_, agents, versions, message) => {
    const run = await runCli(['eval', 'Summariser'], {
      cwd: root,
      route: (request) => {
        const { pathname } = request.url;
        if (pathname === '/api/agents') return json(200, agents);
        if (pathname === `/api/agents/${IDS.agent}/versions`) return json(200, versions);
        return json(201, evaluation(7, [[], []]));
      },
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain(message);
    expect(run.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('exits 2 at the line of a case the schema refuses, before any request', async () => {
    const bad = await tempDirectory();
    await tempFile(bad, 'evals/Summariser.yaml', EVALS.replace('notContains', 'excludes'));
    const run = await runCli(['eval', 'Summariser'], {
      cwd: bad,
      route: route(() => json(500, {})),
    });
    await rm(bad, { recursive: true, force: true });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('evals/Summariser.yaml line 7');
    expect(run.calls).toHaveLength(0);
  });

  it('exits 1 with the code when the server refuses the version', async () => {
    const run = await runCli(['eval', 'Summariser', '3'], {
      cwd: root,
      route: route(() =>
        json(404, {
          error: {
            code: 'agent_version_not_found',
            message: 'No such version.',
            details: ['version:3'],
          },
        }),
      ),
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('error: agent_version_not_found');
  });
});
