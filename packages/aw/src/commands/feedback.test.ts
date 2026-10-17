import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadEvalCases } from '../project/index.js';
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

/** Issue #620: `aw feedback` and `aw eval add-case`. */

const DOWN = {
  runId: IDS.run,
  rating: 'down',
  comment: 'Gave the wrong order.',
  input: 'Where is order 1042?',
  answer: 'Order 1043 has shipped.',
  createdAt: '2026-10-04T00:00:00.000Z',
};
/** The judge a rater's comment becomes (BH061-049): the fault to avoid, not the rubric itself. */
const JUDGE =
  'An earlier answer was rated down with: "Gave the wrong order.". Pass only if this answer does not have that problem.';
const EVALS = `# Support cases
cases:
  - name: order status
    input: Where is order 1042?
    expect:
      contains:
        - shipped
`;

function route(items: readonly unknown[] = [DOWN]): Route {
  return (request) => {
    const { pathname } = request.url;
    if (pathname === '/api/agents') return json(200, { agents: [FIXTURES.agent] });
    if (pathname === `/api/agents/${IDS.agent}`) return json(200, FIXTURES.agent);
    if (pathname === `/api/runs/${IDS.run}`) return json(200, { run: runFixture('completed') });
    if (pathname === `/api/agents/${IDS.agent}/feedback`) return json(200, { items });
    return json(404, { error: { code: 'not_found', message: pathname } });
  };
}

let root: string;

beforeEach(async () => {
  root = await tempDirectory();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const evalsFile = () => path.join(root, 'evals', 'Summariser.yaml');

describe('aw feedback', () => {
  it('lists the thumbs-down ratings since a week ago by default', async () => {
    const before = Date.now();
    const run = await runCli(['feedback', 'Summariser', '--negative'], {
      cwd: root,
      route: route(),
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    const query = run.calls.find((call) => call.url.pathname.endsWith('/feedback'))?.url;
    expect(query?.searchParams.get('rating')).toBe('down');
    const since = Date.parse(query?.searchParams.get('since') ?? '');
    expect(before - since).toBeLessThanOrEqual(7 * 86_400_000);
    expect(before - since).toBeGreaterThan(7 * 86_400_000 - 60_000);
    expect(run.stdout).toMatch(/run\s+rating\s+input\s+answer\s+comment/u);
    expect(run.stdout).toContain('Gave the wrong order.');
  });

  it('takes --since in hours, every rating without --negative, and prints JSON', async () => {
    const run = await runCli(['feedback', 'Summariser', '--since', '12h', '--json'], {
      cwd: root,
      route: route(),
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    const query = run.calls.find((call) => call.url.pathname.endsWith('/feedback'))?.url;
    expect(query?.searchParams.has('rating')).toBe(false);
    expect(stdoutJson(run)).toEqual([DOWN]);
  });

  it.each(['7', '1w', '0d', 'yesterday'])('refuses --since %s as a usage error', async (since) => {
    const run = await runCli(['feedback', 'Summariser', '--since', since], {
      cwd: root,
      route: route(),
    });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.calls).toEqual([]);
  });
});

describe('aw feedback without an agent', () => {
  it('is a usage error naming the files when several evals files exist', async () => {
    await tempFile(root, 'evals/a.yaml', EVALS);
    await tempFile(root, 'evals/b.yaml', EVALS);
    const run = await runCli(['feedback'], { cwd: root, route: route() });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('(found a.yaml, b.yaml)');
  });
});

describe('aw eval add-case', () => {
  it('prints the case as a diff and writes nothing without --yes', async () => {
    const run = await runCli(['eval', 'add-case', IDS.run], { cwd: root, route: route() });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toContain('+++ evals/Summariser.yaml');
    expect(run.stdout).toContain(`+  - name: run ${IDS.run.slice(0, 8)}`);
    expect(run.stdout).toContain(
      `+      judge: 'An earlier answer was rated down with: "Gave the wrong order."`,
    );
    expect(run.stderr).toContain('--yes');
    await expect(readFile(evalsFile(), 'utf8')).rejects.toThrow();
  });

  it('creates the file with --yes, and the case loads as an evaluation case', async () => {
    const run = await runCli(['eval', 'add-case', IDS.run, '--yes'], { cwd: root, route: route() });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(await loadEvalCases(root, 'Summariser')).toEqual({
      cases: [
        {
          name: `run ${IDS.run.slice(0, 8)}`,
          input: 'Where is order 1042?',
          expect: { judge: JUDGE },
          fromRun: IDS.run,
        },
      ],
    });
  });

  it('appends to an existing file and keeps its comments (BH061-049)', async () => {
    await tempFile(root, 'evals/Summariser.yaml', EVALS);
    const noComment = { ...DOWN, comment: null };
    const run = await runCli(['eval', 'add-case', IDS.run, '--yes'], {
      cwd: root,
      route: route([noComment]),
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).not.toContain('-# Support cases');
    expect(await readFile(evalsFile(), 'utf8')).toContain(EVALS);
    const { cases } = await loadEvalCases(root, 'Summariser');
    expect(cases.map((each) => each.name)).toEqual(['order status', `run ${IDS.run.slice(0, 8)}`]);
    expect(cases[1]?.expect).toEqual({ judge: 'Must not repeat: Order 1043 has shipped.' });
  });

  it.each([
    ['no thumbs-down', [], 'has no thumbs-down'],
    ['no stored prompt', [{ ...DOWN, input: null }], 'before prompts were stored'],
    ['nothing to judge by', [{ ...DOWN, comment: null, answer: ' ' }], 'neither a comment'],
    ['an input over 8192 characters', [{ ...DOWN, input: 'x'.repeat(8193) }], 'input'],
  ])('refuses a run with %s and writes nothing', async (_kind, items, message) => {
    const run = await runCli(['eval', 'add-case', IDS.run, '--yes'], {
      cwd: root,
      route: route(items),
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain(message);
    await expect(readFile(evalsFile(), 'utf8')).rejects.toThrow();
  });

  it('refuses a case already in the file', async () => {
    await runCli(['eval', 'add-case', IDS.run, '--yes'], { cwd: root, route: route() });
    const again = await runCli(['eval', 'add-case', IDS.run, '--yes'], {
      cwd: root,
      route: route(),
    });
    expect(again.code).toBe(EXIT_CODE.problem);
    expect(again.stderr).toContain(`run ${IDS.run} is already a case in evals/Summariser.yaml`);
  });

  it('refuses a run already in the file under another case name', async () => {
    await tempFile(
      root,
      'evals/Summariser.yaml',
      `${EVALS}  - name: renamed
    input: Where is order 1042?
    expect:
      judge: Gave the wrong order.
    fromRun: ${IDS.run}
`,
    );
    const run = await runCli(['eval', 'add-case', IDS.run, '--yes'], { cwd: root, route: route() });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain(`run ${IDS.run} is already a case in evals/Summariser.yaml`);
  });

  it('prints the result, not a diff, under --json', async () => {
    const run = await runCli(['eval', 'add-case', IDS.run, '--yes', '--json'], {
      cwd: root,
      route: route(),
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(stdoutJson(run)).toEqual({
      file: 'evals/Summariser.yaml',
      case: {
        name: `run ${IDS.run.slice(0, 8)}`,
        input: 'Where is order 1042?',
        expect: { judge: JUDGE },
        fromRun: IDS.run,
      },
      written: true,
    });
    expect((await loadEvalCases(root, 'Summariser')).cases).toHaveLength(1);
  });
});
