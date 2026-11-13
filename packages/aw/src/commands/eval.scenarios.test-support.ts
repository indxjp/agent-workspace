import { rm } from 'node:fs/promises';
import type { EvaluationRunStatus } from '@indx-workspace/contracts/evaluations';
import { FIXTURES, IDS, json, runCli, tempDirectory, tempFile, type Route } from '../testing.js';
import { AT, EVALS, evaluation, route } from './eval.fixture.test-support.js';

export const COMMENTED = `# the cases that gate a release
cases:
  # greeting
  - name: greets
    input: "hi"
    expect: { contains: ["help"] }
`;
export const failing = () => json(201, evaluation(7, [[], ['notContains: "refund"']]));
export const RUN_ID = '77777777-7777-4777-8777-777777777777';
export const CASES = 25;
const names = Array.from({ length: CASES }, (_, index) => `case ${String(index)}`);
export const file = `cases:\n${names.map((name) => `  - { name: ${name}, input: hi, expect: { contains: [hi] } }\n`).join('')}`;
export const resource = (done: number) => ({
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
export const advancing = (answers: readonly (() => Response)[]): Route => {
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
export const dropped = (): never => {
  throw new TypeError('fetch failed');
};
export const olderServer = (request: Parameters<Route>[0]): ReturnType<Route> => {
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
export const posted = (run: Awaited<ReturnType<typeof runCli>>) =>
  run.calls.filter((call) => call.method === 'POST').map((call) => call.url.pathname);
export const BASELINE_ID = '99999999-9999-4999-8999-999999999999';
const baseline = (status: EvaluationRunStatus) => ({
  ...evaluation(6, [[], []]),
  id: BASELINE_ID,
  status,
});
export const withBaseline = (status: EvaluationRunStatus = 'completed'): Route => {
  const inner = route(failing);
  return (request) =>
    request.url.pathname === `/api/agents/${IDS.agent}/evaluation-runs` && request.method === 'GET'
      ? request.url.searchParams.get('evaluation') === BASELINE_ID
        ? json(200, baseline(status))
        : json(404, { error: { code: 'evaluation_not_found', message: 'No such evaluation.' } })
      : inner(request);
};
export async function twoAgents(args: readonly string[], names: readonly string[]) {
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
