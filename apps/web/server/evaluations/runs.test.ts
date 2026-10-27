import type { AgentVersionRecord } from '@agent-workspace/core/db';
import { canonicalCall } from '@indx-workspace/contracts/agents';
import { EvaluationRunResourceSchema, type EvalCase } from '@indx-workspace/contracts/evaluations';
import { describe, expect, it, vi } from 'vitest';

import type { LaunchContext, RunPrincipal, RunApiEnvironment } from '../runs/environment';
import { InMemoryRunStore } from '../runs/memory-store';
import { assistantSays, ORDER_STATUS_FRAMES } from './fixtures';
import {
  advanceEvaluationRun,
  getEvaluationRun,
  startEvaluationRun,
  type EvaluationRunDependencies,
} from './runs';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const OTHER_AGENT = '33333333-3333-4333-8333-444444444444';
const VERSION_ID = '44444444-4444-4444-8444-444444444444';
const PRINCIPAL: RunPrincipal = {
  principalId: '77777777-7777-4777-8777-777777777777',
  ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
  userId: null,
  workspaceId: WORKSPACE,
  role: 'builder',
  scope: null,
};

interface Row {
  id: string;
  agentId: string;
  versionId: string;
  version: number;
  status: 'running' | 'completed';
  score: string;
  passed: number;
  total: number;
  casesSnapshot: unknown;
  results: unknown;
  createdAt: Date;
  leased: boolean;
}

/** The run API with the evaluation-run storage held in memory, one lease per run. */
function setUp(latencyMs = 0) {
  const store = new InMemoryRunStore();
  const rows = new Map<string, Row>();
  const playing: Promise<void>[] = [];
  /** The `outputSchema` each launched run was started with (`undefined` when it had none). */
  const schemas: (Readonly<Record<string, unknown>> | undefined)[] = [];
  const interrupted: string[] = [];
  const play = async ({ run, prompt, outputSchema }: LaunchContext) => {
    schemas.push(outputSchema);
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    if (prompt === PAUSING_PROMPT) {
      await store.append(run.id, {
        type: 'agent.message',
        data: assistantSays('Plan ready for approval.'),
      });
      await store.markRunning(run.id);
      await store.awaitApproval(run.id, {
        toolName: 'Write',
        canonicalCall: canonicalCall('Write', { file_path: 'outputs/plan.json' }),
      });
      return;
    }
    for (const frame of ORDER_STATUS_FRAMES) {
      await store.append(run.id, { type: frame.frame, data: frame });
    }
    const output =
      outputSchema === undefined ? null : { text: 'Drafted.', structured: DRAFTED_OUTLINE };
    await store.finish(run.id, 'completed', null, true, output);
  };
  const stored = (row: Row) => ({ ...row, leaseUntil: null });
  const runs: RunApiEnvironment = {
    authenticate: () => Promise.resolve(PRINCIPAL),
    findAgent: () =>
      Promise.resolve({ id: AGENT, workspaceId: WORKSPACE, engine: 'claude-agent-sdk' }),
    openSession: (_principal, agent, _requested, agentVersionId) =>
      Promise.resolve({
        id: crypto.randomUUID(),
        agentId: agent.id,
        engine: null,
        agentVersionId: agentVersionId ?? null,
      }),
    ownsRun: () => Promise.resolve(true),
    interruptRun: async (_principal, run) => {
      interrupted.push(run.id);
      await store.finish(run.id, 'cancelled', null, true);
    },
    store,
    launch: (context) => {
      playing.push(play(context));
    },
    preflight: () => Promise.resolve(null),
    evaluationRuns: {
      start: (_principal, run) => {
        const row: Row = {
          id: crypto.randomUUID(),
          agentId: AGENT,
          versionId: run.versionId,
          version: 7,
          status: 'running',
          score: '0',
          passed: 0,
          total: run.total,
          // Stored as JSON, as the jsonb column does.
          casesSnapshot: JSON.parse(JSON.stringify(run.casesSnapshot)) as unknown,
          results: [],
          createdAt: new Date('2026-10-07T00:00:00Z'),
          leased: false,
        };
        rows.set(row.id, row);
        return Promise.resolve({ id: row.id, createdAt: row.createdAt });
      },
      find: (_principal, id) => {
        const row = rows.get(id);
        return Promise.resolve(row === undefined ? null : stored(row));
      },
      claim: (_principal, id) => {
        const row = rows.get(id);
        if (row === undefined || row.status !== 'running' || row.leased)
          return Promise.resolve(null);
        row.leased = true;
        return Promise.resolve(stored(row));
      },
      progress: (_principal, id, progress) => {
        const row = rows.get(id);
        if (row === undefined || row.status !== 'running') return Promise.resolve();
        row.results = progress.results;
        row.passed = progress.passed;
        row.score = (progress.passed / row.total).toFixed(4);
        if (progress.completed) row.status = 'completed';
        if (progress.completed || progress.release) row.leased = false;
        return Promise.resolve();
      },
    },
  };
  const version: AgentVersionRecord = {
    id: VERSION_ID,
    workspaceId: WORKSPACE,
    agentId: AGENT,
    number: 7,
    summary: 'v7',
    via: 'aw-push',
    body: {},
    createdByPrincipalId: PRINCIPAL.principalId,
    createdAt: new Date(),
  };
  const versions = {
    find: (_agentId: string, number: number) => Promise.resolve(number === 7 ? version : null),
  };
  const dependencies: EvaluationRunDependencies = { runs };
  return {
    rows,
    interrupted,
    schemas,
    store,
    runs,
    start: (body: unknown) => startEvaluationRun(body, AGENT, PRINCIPAL, { runs, store: versions }),
    advance: async (id: string, deps: EvaluationRunDependencies = dependencies, agent = AGENT) => {
      const result = await advanceEvaluationRun({ evaluationId: id }, agent, PRINCIPAL, deps);
      await Promise.all(playing);
      return result;
    },
    get: (id: string | null, agent = AGENT) => getEvaluationRun(agent, id, PRINCIPAL, dependencies),
    dependencies,
  };
}

const PAUSING_PROMPT = 'Plan the consolidation';
const DRAFTED_OUTLINE = { width: 140, height: 90, drawingNo: 'BRK-1101' };
const DRAFT_SCHEMA = { type: 'object', properties: { width: { type: 'number' } } };
const drafting = (name: string, output: Readonly<Record<string, unknown>>): EvalCase => ({
  name,
  input: 'Draft the change set',
  outputSchema: DRAFT_SCHEMA,
  expect: { output },
});

const passing = (name: string): EvalCase => ({
  name,
  input: 'Where is order 1042?',
  expect: { tool: 'orders_getOrder', contains: ['shipped'] },
});

async function started(h: ReturnType<typeof setUp>, cases: readonly EvalCase[]) {
  const result = await h.start({ version: 7, cases });
  expect(result.status).toBe(202);
  return EvaluationRunResourceSchema.parse(result.body);
}

describe('startEvaluationRun (issue #799)', () => {
  it('stores a running run and starts no case', async () => {
    const h = setUp();
    const run = await started(h, [passing('a'), passing('b')]);
    expect(run).toMatchObject({
      agentId: AGENT,
      version: 7,
      status: 'running',
      score: 0,
      passed: 0,
      total: 2,
      results: [],
    });
    expect(h.rows.get(run.id)).toMatchObject({ versionId: VERSION_ID, status: 'running' });
    expect((await h.store.listRuns(WORKSPACE, { limit: 10 })).items).toEqual([]);
  });

  it('takes 200 cases, where the synchronous evaluation takes 20', async () => {
    const h = setUp();
    const cases = Array.from({ length: 200 }, (_, index) => passing(`case ${String(index)}`));
    expect((await h.start({ version: 7, cases })).status).toBe(202);
    expect((await h.start({ version: 7, cases: [...cases, passing('one more')] })).status).toBe(
      400,
    );
  });

  it.each([
    ['an empty case list', { version: 7, cases: [] }, 400, 'invalid_body'],
    ['a missing version', { version: 8, cases: [passing('a')] }, 404, 'agent_version_not_found'],
  ] as const)('refuses %s and stores nothing', async (_, body, status, code) => {
    const h = setUp();
    const result = await h.start(body);
    expect(result.status).toBe(status);
    expect(result.body).toMatchObject({ error: { code } });
    expect(h.rows.size).toBe(0);
  });

  it('answers 503 without a run API', async () => {
    const result = await startEvaluationRun(
      { version: 7, cases: [passing('a')] },
      AGENT,
      PRINCIPAL,
      {
        runs: null,
        store: { find: () => Promise.resolve(null) },
      },
    );
    expect(result).toMatchObject({
      status: 503,
      body: { error: { code: 'run_api_not_configured' } },
    });
  });
});

describe('advanceEvaluationRun (issue #799)', () => {
  it('runs every case in one call when the budget allows and completes the run', async () => {
    const h = setUp();
    const run = await started(h, [passing('a'), passing('b'), passing('c')]);
    const result = await h.advance(run.id);
    expect(result.status).toBe(200);
    expect(EvaluationRunResourceSchema.parse(result.body)).toMatchObject({
      status: 'completed',
      score: 1,
      passed: 3,
      total: 3,
    });
  });

  it('runs one case per call when the budget is spent, and resumes where it stopped', async () => {
    const h = setUp();
    const run = await started(h, [passing('a'), passing('b'), passing('c')]);
    const steps = { runs: h.runs, advanceBudgetMs: 0 };
    const seen: [string, number][] = [];
    for (let call = 0; call < 3; call += 1) {
      const body = EvaluationRunResourceSchema.parse((await h.advance(run.id, steps)).body);
      seen.push([body.status, body.results.length]);
    }
    expect(seen).toEqual([
      ['running', 1],
      ['running', 2],
      ['completed', 3],
    ]);
    expect((await h.store.listRuns(WORKSPACE, { limit: 10 })).items).toHaveLength(3);
    expect(h.rows.get(run.id)?.leased).toBe(false);
  });

  // Issue #1021: the synchronous evaluation shared one deadline across the file, so the last cases
  // of a slow agent ended `deadline_exceeded`. Here every case is slow by itself but not by much.
  it('gives each case its own deadline, so the cases together may outlast one', async () => {
    const h = setUp(150);
    const run = await started(h, [
      passing('a'),
      passing('b'),
      passing('c'),
      passing('d'),
      passing('e'),
    ]);
    const body = EvaluationRunResourceSchema.parse(
      (await h.advance(run.id, { runs: h.runs, caseDeadlineMs: 600 })).body,
    );
    expect(body).toMatchObject({ status: 'completed', passed: 5, total: 5 });
    expect(body.results.flatMap((result) => result.failures)).toEqual([]);
  });

  it('answers a completed run unchanged and starts no further case', async () => {
    const h = setUp();
    const run = await started(h, [passing('a')]);
    const first = await h.advance(run.id);
    const again = await h.advance(run.id);
    expect(again).toEqual(first);
    expect((await h.store.listRuns(WORKSPACE, { limit: 10 })).items).toHaveLength(1);
  });

  it('scores each case, so a failing case is named and the score is a fraction', async () => {
    const h = setUp();
    const run = await started(h, [
      passing('a'),
      {
        name: 'wrong args',
        input: 'Where is order 1042?',
        expect: { tool: 'orders_getOrder', toolInput: { orderNumber: '9' } },
      },
      {
        name: 'right args',
        input: 'Where is order 1042?',
        expect: { tool: 'orders_getOrder', toolInput: { orderNumber: '1042' } },
      },
    ]);
    const body = EvaluationRunResourceSchema.parse((await h.advance(run.id)).body);
    expect(body.results.map((result) => [result.name, result.failures])).toEqual([
      ['a', []],
      ['wrong args', ['toolInput: no call of orders_getOrder had {"orderNumber":"9"}']],
      ['right args', []],
    ]);
    expect(body).toMatchObject({ passed: 2, total: 3, score: 0.6667 });
  });

  // Issue #1289: the cases go through `casesSnapshot` before they run, and must keep `outputSchema`.
  it('starts a stored case with its outputSchema and scores its structured output', async () => {
    const h = setUp();
    const run = await started(h, [
      drafting('right outline', { width: 140, height: 90 }),
      passing('a'),
      drafting('wrong outline', { width: 141 }),
    ]);
    const body = EvaluationRunResourceSchema.parse((await h.advance(run.id)).body);
    expect(h.schemas).toEqual([DRAFT_SCHEMA, undefined, DRAFT_SCHEMA]);
    expect(body.results.map((result) => [result.name, result.failures])).toEqual([
      ['right outline', []],
      ['a', []],
      ['wrong outline', ['output: the structured output did not have {"width":141}']],
    ]);
  });

  // Issue #1569: a case that expects the approval pause is scored there, and its run is cancelled.
  it('scores a case at the approval pause and cancels its run', async () => {
    const h = setUp();
    const run = await started(h, [
      {
        name: 'stops at the plan write',
        input: PAUSING_PROMPT,
        expect: {
          awaitsApproval: true,
          tool: 'Write',
          toolInput: { file_path: 'outputs/plan.json' },
          contains: ['Plan ready'],
        },
      },
      passing('a'),
    ]);
    const body = EvaluationRunResourceSchema.parse((await h.advance(run.id)).body);
    expect(body).toMatchObject({ status: 'completed', passed: 2, total: 2 });
    const pausedRunId = body.results[0]?.runId ?? '';
    await vi.waitFor(async () => {
      expect((await h.store.get(pausedRunId))?.status).toBe('cancelled');
    });
    expect(h.interrupted).toEqual([pausedRunId]);
  });

  it('refuses a second advance while one holds the lease', async () => {
    const h = setUp();
    const run = await started(h, [passing('a')]);
    const row = h.rows.get(run.id);
    if (row !== undefined) row.leased = true;
    const result = await h.advance(run.id);
    expect(result).toMatchObject({ status: 409, body: { error: { code: 'evaluation_run_busy' } } });
    expect(h.rows.get(run.id)?.results).toEqual([]);
  });

  it('frees the lease and keeps the stored cases when an advance fails midway', async () => {
    const h = setUp();
    const run = await started(h, [passing('a'), passing('b')]);
    let opened = 0;
    const openSession = h.runs.openSession.bind(h.runs);
    const failing: RunApiEnvironment = {
      ...h.runs,
      openSession: (...args) => {
        if (++opened === 2) throw new Error('the database went away');
        return openSession(...args);
      },
    };
    await expect(h.advance(run.id, { runs: failing })).rejects.toThrow('the database went away');
    expect(h.rows.get(run.id)).toMatchObject({ status: 'running', leased: false, passed: 1 });
    const result = await h.advance(run.id);
    expect(EvaluationRunResourceSchema.parse(result.body)).toMatchObject({
      status: 'completed',
      passed: 2,
    });
  });

  it('answers a refused first start, stores nothing and leaves the run running and free', async () => {
    const h = setUp();
    const run = await started(h, [passing('a'), passing('b')]);
    const refusing: RunApiEnvironment = {
      ...h.runs,
      preflight: () => Promise.resolve({ code: 'model_unavailable', message: 'gone.' }),
    };
    expect(await h.advance(run.id, { runs: refusing })).toEqual({
      status: 422,
      body: { error: { code: 'model_unavailable', message: 'gone.' } },
    });
    expect(h.rows.get(run.id)).toMatchObject({ status: 'running', leased: false, results: [] });
  });

  it('frees the lease when the stored snapshot does not parse', async () => {
    const h = setUp();
    const run = await started(h, [passing('a')]);
    const row = h.rows.get(run.id);
    if (row !== undefined) row.casesSnapshot = [{ name: 'broken' }];
    await expect(h.advance(run.id)).rejects.toThrow();
    expect(h.rows.get(run.id)).toMatchObject({ status: 'running', leased: false });
  });

  it('answers 404 for an id nobody stored', async () => {
    const h = setUp();
    expect(await h.advance('55555555-5555-4555-8555-555555555555')).toMatchObject({
      status: 404,
      body: { error: { code: 'evaluation_not_found' } },
    });
  });

  it('answers 400 for an id that is not a UUID or a body that is not an advance request', async () => {
    const h = setUp();
    expect(await h.advance('nope')).toMatchObject({
      status: 400,
      body: { error: { code: 'invalid_body' } },
    });
    expect(await advanceEvaluationRun({}, AGENT, PRINCIPAL, h.dependencies)).toMatchObject({
      status: 400,
    });
  });

  it("answers 404 for another agent's run and runs nothing", async () => {
    const h = setUp();
    const run = await started(h, [passing('a')]);
    expect(await h.advance(run.id, h.dependencies, OTHER_AGENT)).toMatchObject({ status: 404 });
    expect((await h.store.listRuns(WORKSPACE, { limit: 10 })).items).toEqual([]);
  });
});

describe('getEvaluationRun (issue #799)', () => {
  it('answers a completed run with its results', async () => {
    const h = setUp();
    const run = await started(h, [passing('a')]);
    await h.advance(run.id);
    const result = await h.get(run.id);
    expect(result.status).toBe(200);
    expect(EvaluationRunResourceSchema.parse(result.body)).toMatchObject({
      id: run.id,
      agentId: AGENT,
      version: 7,
      status: 'completed',
      score: 1,
    });
  });

  it('answers a run that has not completed with its progress', async () => {
    const h = setUp();
    const run = await started(h, [passing('a')]);
    expect(await h.get(run.id)).toMatchObject({
      status: 200,
      body: { status: 'running', results: [] },
    });
  });

  it("answers 404 for another agent's run, an id that is not a UUID and no id", async () => {
    const h = setUp();
    const run = await started(h, [passing('a')]);
    await h.advance(run.id);
    expect(await h.get(run.id, OTHER_AGENT)).toMatchObject({ status: 404 });
    expect(await h.get('nope')).toMatchObject({ status: 404 });
    expect(await h.get(null)).toMatchObject({ status: 404 });
  });
});
