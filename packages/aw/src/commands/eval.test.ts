import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

/** Issue #618: `aw eval [agent] [version]`. */

const AT = '2026-10-04T00:00:00.000Z';
const EVALUATION_ID = '88888888-8888-4888-8888-888888888888';
const EVALS = `cases:
  - name: order status
    input: "Where is order 1042?"
    expect: { contains: ["shipped"] }
  - name: no refund promises
    input: "I want my money back now"
    expect: { notContains: ["refund"] }
`;

function evaluation(version: number, failures: readonly (readonly string[])[]) {
  const passed = failures.filter((list) => list.length === 0).length;
  return {
    id: EVALUATION_ID,
    agentId: IDS.agent,
    version,
    score: passed / failures.length,
    passed,
    total: failures.length,
    results: failures.map((list, index) => ({
      name: index === 0 ? 'order status' : 'no refund promises',
      passed: list.length === 0,
      runId: IDS.run,
      failures: list,
    })),
    createdAt: AT,
  };
}

const LIST = {
  items: [],
  pointers: [{ environment: 'local', number: 7, updatedAt: AT }],
  materialised: 7,
};

const RUNS_PATH = `/api/agents/${IDS.agent}/evaluation-runs`;
const ADVANCE_PATH = `/api/agents/${IDS.agent}/evaluation-advance`;

/**
 * The agents, the versions, and `answer` for the POST that creates an evaluation run. `answer`
 * gives the finished evaluation (201) or an error; a finished one is served as a completed run, so
 * the CLI has nothing left to advance.
 */
function route(answer: (body: unknown) => Response): Route {
  return async (request) => {
    const { pathname } = request.url;
    if (pathname === '/api/agents') return json(200, { agents: [FIXTURES.agent] });
    if (pathname === `/api/agents/${IDS.agent}/versions`) return json(200, LIST);
    if (pathname === `/api/agents/${IDS.agent}/evaluation-runs` && request.method === 'POST') {
      const answered = answer(request.json);
      if (answered.status !== 201) return answered;
      const finished = (await answered.json()) as object;
      return json(202, { ...finished, status: 'completed' });
    }
    return json(404, { error: { code: 'not_found', message: pathname } });
  };
}

let root: string;
let empty: string;

beforeAll(async () => {
  root = await tempDirectory();
  empty = await tempDirectory();
  await tempFile(root, 'evals/Summariser.yaml', EVALS);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(empty, { recursive: true, force: true });
});

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

  /** Two evals files; the first evaluation created, `Other`'s, has one failing case. */
  async function twoAgents(args: readonly string[], names: readonly string[]) {
    const cwd = await tempDirectory();
    await tempFile(cwd, 'evals/Summariser.yaml', EVALS);
    await tempFile(cwd, 'evals/Other.yaml', EVALS);
    let created = 0;
    const evaluations = route(() => {
      created += 1;
      return json(201, evaluation(7, created === 1 ? [[], ['notContains: "refund"']] : [[], []]));
    });
    const run = await runCli(args, {
      cwd,
      route: (request) =>
        request.url.pathname === '/api/agents'
          ? json(200, {
              agents: [FIXTURES.agent, ...names.map((name) => ({ ...FIXTURES.agent, name }))],
            })
          : evaluations(request),
    });
    await rm(cwd, { recursive: true, force: true });
    return run;
  }

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

/** Issue #799: `aw eval run`, `--min-score`, `--junit`, `--baseline` and the asynchronous path. */
describe('aw eval run', () => {
  const failing = () => json(201, evaluation(7, [[], ['notContains: "refund"']]));

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
    const BASELINE_ID = '99999999-9999-4999-8999-999999999999';
    const baseline = (status: 'completed' | 'running') => ({
      ...evaluation(6, [[], []]),
      id: BASELINE_ID,
      status,
    });
    const withBaseline = (status: 'completed' | 'running' = 'completed'): Route => {
      const inner = route(failing);
      return (request) =>
        request.url.pathname === `/api/agents/${IDS.agent}/evaluation-runs` &&
        request.method === 'GET'
          ? request.url.searchParams.get('evaluation') === BASELINE_ID
            ? json(200, baseline(status))
            : json(404, { error: { code: 'evaluation_not_found', message: 'No such evaluation.' } })
          : inner(request);
    };

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

  describe('a file of more than 20 cases', () => {
    const RUN_ID = '77777777-7777-4777-8777-777777777777';
    const CASES = 25;
    const names = Array.from({ length: CASES }, (_, index) => `case ${String(index)}`);
    const file = `cases:\n${names.map((name) => `  - { name: ${name}, input: hi, expect: { contains: [hi] } }\n`).join('')}`;

    /** The run's resource with the first `done` cases finished, the 24th one failing. */
    const resource = (done: number) => ({
      id: RUN_ID,
      agentId: IDS.agent,
      version: 7,
      status: done === CASES ? 'completed' : 'running',
      score: 0,
      passed: done - (done >= 24 ? 1 : 0),
      total: CASES,
      results: names.slice(0, done).map((name, index) => ({
        name,
        passed: index !== 23,
        runId: IDS.run,
        failures: index === 23 ? ['contains: "hi"'] : [],
      })),
      createdAt: AT,
    });

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

    /** A route whose advances answer from `answers`, in order; the run is created as in the tests above. */
    const advancing = (answers: readonly (() => Response)[]): Route => {
      const left = [...answers];
      return (request) => {
        const { pathname } = request.url;
        if (pathname === `/api/agents/${IDS.agent}/evaluation-runs`) return json(202, resource(0));
        if (pathname === `/api/agents/${IDS.agent}/evaluation-advance`) {
          return left.shift()?.() ?? json(200, resource(CASES));
        }
        return route(() => json(500, {}))(request);
      };
    };
    const dropped = (): never => {
      throw new TypeError('fetch failed');
    };

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

    /** A server before #799: no evaluation-run routes, so Next.js answers its HTML 404 page. */
    const olderServer = (request: Parameters<Route>[0]): ReturnType<Route> => {
      const { pathname } = request.url;
      if (pathname === `/api/agents/${IDS.agent}/evaluation-runs`) {
        return new Response('<!DOCTYPE html><title>404</title>', {
          status: 404,
          headers: { 'content-type': 'text/html' },
        });
      }
      if (pathname === `/api/agents/${IDS.agent}/evaluations` && request.method === 'POST') {
        return json(201, evaluation(7, [[], []]));
      }
      return route(failing)(request);
    };
    const posted = (run: Awaited<ReturnType<typeof runCli>>) =>
      run.calls.filter((call) => call.method === 'POST').map((call) => call.url.pathname);

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

  // Issue #1021: the synchronous request gave a whole file one 225 s budget, so the last cases of
  // a slow agent ended `deadline_exceeded`; a run gives every case its own deadline.
  describe('a file of 20 cases or fewer', () => {
    const RUN_ID = '77777777-7777-4777-8777-777777777777';
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

/** Issue #698: `aw eval add "<input>"` edits the YAML locally. */
describe('aw eval add', () => {
  const COMMENTED = `# the cases that gate a release
cases:
  # greeting
  - name: greets
    input: "hi"
    expect: { contains: ["help"] }
`;

  it('appends a case to the only evals file, keeping comments, and sends nothing', async () => {
    const cwd = await tempDirectory();
    await tempFile(cwd, 'evals/Summariser.yaml', COMMENTED);
    const run = await runCli(
      [
        'eval',
        'add',
        'where is my order?',
        '--expect-tool',
        'get_order',
        '--expect-contains',
        'order',
      ],
      { cwd, route: () => json(500, {}) },
    );
    const text = await readFile(path.join(cwd, 'evals/Summariser.yaml'), 'utf8');
    await rm(cwd, { recursive: true, force: true });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls).toHaveLength(0);
    expect(text).toContain('# the cases that gate a release');
    expect(text).toContain('# greeting');
    expect(text.indexOf('name: greets')).toBeLessThan(text.indexOf('where is my order?'));
    expect(text).toContain('tool: get_order');
    expect(run.stderr).toContain('added "where is my order?" to evals/Summariser.yaml');
  });

  it('creates the file for a named agent that has none', async () => {
    const cwd = await tempDirectory();
    const run = await runCli(
      ['eval', 'add', 'hi', '--agent', 'Fresh', '--expect-contains', 'hello'],
      {
        cwd,
        route: () => json(500, {}),
      },
    );
    const text = await readFile(path.join(cwd, 'evals/Fresh.yaml'), 'utf8');
    await rm(cwd, { recursive: true, force: true });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(text).toContain('name: hi');
  });

  it('refuses a case with no expectation, with the schema message, and leaves the file alone', async () => {
    const cwd = await tempDirectory();
    await tempFile(cwd, 'evals/Summariser.yaml', COMMENTED);
    const run = await runCli(['eval', 'add', 'hi there'], { cwd, route: () => json(500, {}) });
    const text = await readFile(path.join(cwd, 'evals/Summariser.yaml'), 'utf8');
    await rm(cwd, { recursive: true, force: true });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('expect must name at least one of');
    expect(text).toBe(COMMENTED);
  });

  it('asks for --agent when several evals files exist', async () => {
    const cwd = await tempDirectory();
    await tempFile(cwd, 'evals/A.yaml', COMMENTED);
    await tempFile(cwd, 'evals/B.yaml', COMMENTED);
    const run = await runCli(['eval', 'add', 'hi', '--expect-tool', 'x'], {
      cwd,
      route: () => json(500, {}),
    });
    await rm(cwd, { recursive: true, force: true });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('--agent <name> (found A.yaml, B.yaml)');
  });

  it('refuses a repeated --agent and writes nothing', async () => {
    const cwd = await tempDirectory();
    const run = await runCli(
      ['eval', 'add', 'hi', '--agent', 'A', '--agent', 'B', '--expect-contains', 'hello'],
      { cwd, env: {} },
    );
    const written = existsSync(path.join(cwd, 'evals'));
    await rm(cwd, { recursive: true, force: true });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('--agent was given more than once');
    expect(written).toBe(false);
  });

  it('says --agent creates the file when the project has no evals file', async () => {
    const cwd = await tempDirectory();
    const run = await runCli(['eval', 'add', 'hi', '--expect-tool', 'x'], { cwd, env: {} });
    await rm(cwd, { recursive: true, force: true });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('--agent <name>; it creates evals/<name>.yaml');
  });

  it('needs no URL or credential: it runs with an empty environment', async () => {
    const cwd = await tempDirectory();
    const run = await runCli(
      ['eval', 'add', 'hi', '--agent', 'Fresh', '--expect-contains', 'hello'],
      { cwd, env: {} },
    );
    await rm(cwd, { recursive: true, force: true });
    expect(run.code).toBe(EXIT_CODE.ok);
  });

  it('prints the file and the case as JSON with --json', async () => {
    const cwd = await tempDirectory();
    const run = await runCli(
      ['eval', 'add', 'hi', '--agent', 'Fresh', '--expect-contains', 'hello', '--json'],
      { cwd, env: {} },
    );
    await rm(cwd, { recursive: true, force: true });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(stdoutJson(run)).toEqual({
      file: 'evals/Fresh.yaml',
      case: { name: 'hi', input: 'hi', expect: { contains: ['hello'] } },
    });
  });

  it('treats an empty cases: as no cases and adds the first one', async () => {
    const cwd = await tempDirectory();
    await tempFile(cwd, 'evals/A.yaml', 'cases:\n');
    const run = await runCli(['eval', 'add', 'hi', '--expect-tool', 'x'], { cwd });
    const text = await readFile(path.join(cwd, 'evals/A.yaml'), 'utf8');
    await rm(cwd, { recursive: true, force: true });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(text).toContain('name: hi');
  });

  it.each(['cases: [\n', '- a\n', 'cases: hello\n'])(
    'refuses the existing file %j as a usage error naming it, and leaves it alone',
    async (existing) => {
      const cwd = await tempDirectory();
      await tempFile(cwd, 'evals/A.yaml', existing);
      const run = await runCli(['eval', 'add', 'hi', '--expect-tool', 'x'], { cwd });
      const text = await readFile(path.join(cwd, 'evals/A.yaml'), 'utf8');
      await rm(cwd, { recursive: true, force: true });
      expect(run.code).toBe(EXIT_CODE.usage);
      expect(run.stderr).toContain('evals/A.yaml line');
      expect(text).toBe(existing);
    },
  );
});
