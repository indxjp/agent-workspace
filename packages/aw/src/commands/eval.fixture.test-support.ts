import { rm } from 'node:fs/promises';
import { afterAll, beforeAll } from 'vitest';
import { FIXTURES, IDS, json, tempDirectory, tempFile, type Route } from '../testing.js';

/** Issue #618: `aw eval [agent] [version]`. */

export const AT = '2026-10-04T00:00:00.000Z';

export const EVALUATION_ID = '88888888-8888-4888-8888-888888888888';

export const EVALS = `cases:
  - name: order status
    input: "Where is order 1042?"
    expect: { contains: ["shipped"] }
  - name: no refund promises
    input: "I want my money back now"
    expect: { notContains: ["refund"] }
`;

export function evaluation(version: number, failures: readonly (readonly string[])[]) {
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

export const LIST = {
  items: [],
  pointers: [{ environment: 'local', number: 7, updatedAt: AT }],
  materialised: 7,
};

export const RUNS_PATH = `/api/agents/${IDS.agent}/evaluation-runs`;

export const ADVANCE_PATH = `/api/agents/${IDS.agent}/evaluation-advance`;

/**
 * The agents, the versions, and `answer` for the POST that creates an evaluation run. `answer`
 * gives the finished evaluation (201) or an error; a finished one is served as a completed run, so
 * the CLI has nothing left to advance.
 */
export function route(answer: (body: unknown) => Response): Route {
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

export let root: string;

export let empty: string;

beforeAll(async () => {
  root = await tempDirectory();
  empty = await tempDirectory();
  await tempFile(root, 'evals/Summariser.yaml', EVALS);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(empty, { recursive: true, force: true });
});
