/**
 * Evaluation runs (issue #799): an evaluation of up to `EVALUATION_RUN_CASE_LIMIT` cases that the
 * client drives, because a request cannot outlive the host's HTTP timeout.
 *
 * 1. `POST /api/agents/:id/evaluation-runs` stores a `running` row holding the cases and answers 202.
 * 2. `POST /api/agents/:id/evaluation-advance` takes the row's lease, runs the next cases with the
 *    same {@link runCase} the synchronous evaluation uses, stores each result as it lands and stops
 *    starting cases once the advance has spent {@link EVALUATION_ADVANCE_BUDGET_MS}. The client calls
 *    it until `status` is `completed`. At least one case runs per call, so every call progresses.
 * 3. `GET /api/agents/:id/evaluation-runs?evaluation=<id>` reads the run at any status.
 *
 * A request that dies leaves its lease to expire; the next advance resumes at the first case with no
 * result. The promotion gate only reads completed rows.
 */
import {
  AdvanceEvaluationRunRequestSchema,
  CreateEvaluationRunRequestSchema,
  EVALUATION_PROBLEM_CODES,
  EvalCaseFileSchema,
  EvaluationCaseResultSchema,
  type EvalCase,
  type EvaluationCaseResult,
  type EvaluationRunResource,
} from '@indx-workspace/contracts/evaluations';
import { z } from 'zod';

import { isUuid } from '../agents/contract';
import { formatIssues, problem, type ApiResult } from '../http/result';
import { agentVersionNotFound } from '../agent-versions/problems';
import type { WorkspaceAgentVersionStore } from '../agent-versions/store';
import { readBoundedJson } from '../http/json-transport';
import type { RunPrincipal, RunApiEnvironment } from '../runs/environment';
import { runCase } from './handlers';
import { score } from './score';

/** An advance starts no new case after this long, so it answers inside the host's 240 s timeout. */
export const EVALUATION_ADVANCE_BUDGET_MS = 120_000;

/** One case, its run and its judge, gets this long; with the budget that bounds an advance. */
export const EVALUATION_RUN_CASE_DEADLINE_MS = 100_000;

/** Longer than an advance can take, so a live advance is never taken over. */
const LEASE_MS = EVALUATION_ADVANCE_BUDGET_MS + EVALUATION_RUN_CASE_DEADLINE_MS + 10_000;

/** 200 cases of 8 KiB input and a 2 KiB rubric, plus the checks, fit with room to spare. */
const MAX_EVALUATION_RUN_BODY_BYTES = 4 * 1024 * 1024;

export async function readEvaluationRunBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; result: ApiResult }> {
  return readBoundedJson(request, { maxBytes: MAX_EVALUATION_RUN_BODY_BYTES, problem });
}

export interface EvaluationRunDependencies {
  /** `null` when the deployment has no run API: answered `503 run_api_not_configured`. */
  readonly runs: RunApiEnvironment | null;
  /** The budget and case deadline of an advance, unless a test shortens them. */
  readonly advanceBudgetMs?: number;
  readonly caseDeadlineMs?: number;
}

function notConfigured(): ApiResult {
  return problem(
    EVALUATION_PROBLEM_CODES.run_api_not_configured,
    'run_api_not_configured',
    'Evaluations are not configured for this deployment.',
  );
}

function notFound(): ApiResult {
  return problem(
    EVALUATION_PROBLEM_CODES.evaluation_not_found,
    'evaluation_not_found',
    'No such evaluation.',
  );
}

/** Store a run of `raw`'s cases against a version of agent `agentId`; nothing runs yet. */
export async function startEvaluationRun(
  raw: unknown,
  agentId: string,
  principal: RunPrincipal,
  dependencies: EvaluationRunDependencies & {
    readonly store: Pick<WorkspaceAgentVersionStore, 'find'>;
  },
): Promise<ApiResult> {
  const parsed = CreateEvaluationRunRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return problem(
      EVALUATION_PROBLEM_CODES.invalid_body,
      'invalid_body',
      'The body is not an evaluation run request.',
      formatIssues(parsed.error.issues),
    );
  }
  const { version, cases } = parsed.data;
  const { runs, store } = dependencies;
  const evaluations = runs?.evaluationRuns;
  if (runs === null || evaluations === undefined) return notConfigured();

  const found = await store.find(agentId, version);
  if (found === null) return agentVersionNotFound(version);
  const started = await evaluations.start(principal, {
    versionId: found.id,
    total: cases.length,
    casesSnapshot: cases,
  });
  const body: EvaluationRunResource = {
    id: started.id,
    agentId,
    version,
    status: 'running',
    score: 0,
    passed: 0,
    total: cases.length,
    results: [],
    createdAt: started.createdAt.toISOString(),
  };
  return { status: 202, body };
}

const StoredResultsSchema = z.array(EvaluationCaseResultSchema);

/** Run the next cases of the run `raw` names and answer how far it is. */
export async function advanceEvaluationRun(
  raw: unknown,
  agentId: string,
  principal: RunPrincipal,
  dependencies: EvaluationRunDependencies,
): Promise<ApiResult> {
  const parsed = AdvanceEvaluationRunRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return problem(
      EVALUATION_PROBLEM_CODES.invalid_body,
      'invalid_body',
      'The body is not an evaluation advance request.',
      formatIssues(parsed.error.issues),
    );
  }
  const { evaluationId } = parsed.data;
  const { runs } = dependencies;
  const evaluations = runs?.evaluationRuns;
  if (runs === null || evaluations === undefined) return notConfigured();

  const existing = await evaluations.find(principal, evaluationId);
  if (existing?.agentId !== agentId) return notFound();
  if (existing.status === 'completed') return { status: 200, body: resource(existing) };

  const claimed = await evaluations.claim(principal, evaluationId, LEASE_MS);
  if (claimed === null) {
    // Completed by another request since `find`, or still being advanced by one.
    const now = await evaluations.find(principal, evaluationId);
    if (now?.status === 'completed') return { status: 200, body: resource(now) };
    return problem(
      EVALUATION_PROBLEM_CODES.evaluation_run_busy,
      'evaluation_run_busy',
      'Another request is advancing this evaluation. Try again in a moment.',
    );
  }

  const agent = await runs.findAgent(principal, agentId);
  if (agent === null) {
    await evaluations.progress(principal, evaluationId, {
      results: claimed.results,
      passed: claimed.passed,
      completed: false,
      release: true,
    });
    return problem(EVALUATION_PROBLEM_CODES.agent_not_found, 'agent_not_found', 'No such agent.');
  }

  let cases: readonly EvalCase[];
  let results: EvaluationCaseResult[];
  try {
    cases = EvalCaseFileSchema.parse({ cases: claimed.casesSnapshot }).cases;
    results = [...StoredResultsSchema.parse(claimed.results)];
  } catch (error) {
    // A snapshot that no longer parses still frees the lease.
    await evaluations.progress(principal, evaluationId, {
      results: claimed.results,
      passed: claimed.passed,
      completed: false,
      release: true,
    });
    throw error;
  }
  const budgetEnd = Date.now() + (dependencies.advanceBudgetMs ?? EVALUATION_ADVANCE_BUDGET_MS);
  const first = results.length;
  let refused: ApiResult | null = null;
  try {
    while (results.length < cases.length && (results.length === first || Date.now() < budgetEnd)) {
      const evalCase = cases[results.length];
      if (evalCase === undefined) break;
      const outcome = await runCase(evalCase, {
        runs,
        principal,
        agent,
        versionId: claimed.versionId,
        deadline: Date.now() + (dependencies.caseDeadlineMs ?? EVALUATION_RUN_CASE_DEADLINE_MS),
      });
      // A refused first case answers the refusal, as the synchronous evaluation does, and leaves
      // the run running with nothing stored.
      if (outcome.kind === 'refused' && results.length === 0) {
        refused = problem(outcome.status, outcome.code, outcome.message);
        break;
      }
      results.push(
        outcome.kind === 'scored'
          ? outcome.result
          : { name: evalCase.name, passed: false, runId: null, failures: [outcome.code] },
      );
      const counts = score(results);
      const completed = results.length === cases.length;
      await evaluations.progress(principal, evaluationId, {
        results,
        passed: counts.passed,
        completed,
        release: completed,
      });
    }
  } finally {
    // An error leaves the cases stored so far and frees the lease for the next advance.
    const counts = score(results);
    await evaluations.progress(principal, evaluationId, {
      results,
      passed: counts.passed,
      completed: results.length === cases.length,
      release: true,
    });
  }
  if (refused !== null) return refused;

  const now = await evaluations.find(principal, evaluationId);
  return now === null ? notFound() : { status: 200, body: resource(now) };
}

/** Run `evaluationId` (a query value, `null` when absent) as it stands, at any status. */
export async function getEvaluationRun(
  agentId: string,
  evaluationId: string | null,
  principal: RunPrincipal,
  dependencies: Pick<EvaluationRunDependencies, 'runs'>,
): Promise<ApiResult> {
  const evaluations = dependencies.runs?.evaluationRuns;
  if (evaluations === undefined) return notConfigured();
  if (evaluationId === null || !isUuid(evaluationId)) return notFound();
  const found = await evaluations.find(principal, evaluationId);
  if (found?.agentId !== agentId) return notFound();
  return { status: 200, body: resource(found) };
}

type StoredEvaluation = NonNullable<
  Awaited<ReturnType<NonNullable<RunApiEnvironment['evaluationRuns']>['find']>>
>;

function resource(stored: StoredEvaluation): EvaluationRunResource {
  return {
    id: stored.id,
    agentId: stored.agentId,
    version: stored.version,
    status: stored.status,
    score: Number(stored.score),
    passed: stored.passed,
    total: stored.total,
    results: StoredResultsSchema.parse(stored.results),
    createdAt: stored.createdAt.toISOString(),
  };
}
