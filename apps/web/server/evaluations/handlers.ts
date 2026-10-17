/**
 * `POST /api/agents/:id/evaluations` (issue #618): run each case as an ordinary run, score it on the
 * server and store one `agent_version_evaluations` row. RBAC has already run when
 * {@link evaluateAgentVersion} is called: the route's ownership resolver loaded the agent in the
 * caller's workspace and `decide()` allowed the caller to write it.
 *
 * ## The flow
 *
 * 1. Parse with `CreateEvaluationRequestSchema` → `400 invalid_body`.
 * 2. `find` the version → `404 agent_version_not_found`.
 * 3. Each case, one after another, on a fresh session pinned to that version (#612), whatever
 *    `local` points at: `startRunOnSession`, wait for the run's
 *    stream to end, check the answer, then ask the judge if the case has one. A refused start of
 *    the first case answers that refusal and stores nothing; a later one fails only its case.
 * 4. Score, store, `201` with the evaluation.
 *
 * Synchronous, so it is bounded: at most `EVALUATION_CASE_LIMIT` cases and
 * {@link EVALUATION_DEADLINE_MS} for all of them, the running case and its judge included.
 */
import { randomUUID } from 'node:crypto';

import {
  createProviderRegistry,
  registryProviderId,
} from '@agent-workspace/gateway/providers/registry';
import {
  CreateEvaluationRequestSchema,
  EVALUATION_PROBLEM_CODES,
  type EvalCase,
  type EvaluationCaseFailureCode,
  type EvaluationCaseResult,
  type EvaluationResource,
} from '@indx-workspace/contracts/evaluations';
import { AgentFrameSchema, type AgentFrame } from '@indx-workspace/contracts/run-events';
import { parseRunFailure } from '@indx-workspace/contracts/runs';
import { z } from 'zod';

import { problem, type ApiResult } from '../agents/handlers';
import { agentVersionNotFound } from '../agent-versions/problems';
import type { WorkspaceAgentVersionStore } from '../agent-versions/store';
import type { ModelResolution } from '../compose/run-request';
import type { RunModelQuery } from '../compose/run-preflight';
import { readBoundedJson } from '../http/json-transport';
import type { ResolvedModelConnection } from '../models/store';
import { upgradeEventStream } from '../runs/agent-frames';
import { startRunOnSession } from '../runs/api';
import type { AgentRef, Principal, RunApiEnvironment } from '../runs/environment';
import { isTerminalRunStatus } from '../runs/store';
import { judgePrompt, parseJudgeVerdict } from './judge';
import { checkCase, finalAnswer, score, toolCalls } from './score';

/**
 * The server's budget for one evaluation request: the ACA session-run cap, under ACA's 240 s
 * ingress timeout and Cloud Run's 300 s default. A case still starting or running when it passes is
 * failed with `deadline_exceeded`, its run is interrupted, and no further case starts, so the row is
 * stored rather than the response lost.
 *
 * ponytail: synchronous, one request; move to a job and poll when real case files need more than
 * the host timeout.
 */
export const EVALUATION_DEADLINE_MS = 225_000;

/** 20 cases of 8 KiB input and a 2 KiB rubric, plus the checks, fit with room to spare. */
const MAX_EVALUATION_BODY_BYTES = 512 * 1024;

export async function readEvaluationBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; result: ApiResult }> {
  return readBoundedJson(request, { maxBytes: MAX_EVALUATION_BODY_BYTES, problem });
}

export interface EvaluateAgentVersionDependencies {
  readonly store: Pick<WorkspaceAgentVersionStore, 'find'>;
  /** `null` when the deployment has no run API: answered `503 run_api_not_configured`. */
  readonly runs: RunApiEnvironment | null;
  /** {@link EVALUATION_DEADLINE_MS} unless a test shortens it. */
  readonly deadlineMs?: number;
}

/** Score `raw`'s cases against a version of agent `agentId` and store the evaluation. */
export async function evaluateAgentVersion(
  raw: unknown,
  agentId: string,
  principal: Principal,
  dependencies: EvaluateAgentVersionDependencies,
): Promise<ApiResult> {
  const deadline = Date.now() + (dependencies.deadlineMs ?? EVALUATION_DEADLINE_MS);
  const parsed = CreateEvaluationRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return problem(
      EVALUATION_PROBLEM_CODES.invalid_body,
      'invalid_body',
      'The body is not an evaluation request.',
      parsed.error.issues.map(
        (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
      ),
    );
  }
  const { version, cases } = parsed.data;
  const { store, runs } = dependencies;
  const record = runs?.recordEvaluation;
  if (runs === null || record === undefined) {
    return problem(
      EVALUATION_PROBLEM_CODES.run_api_not_configured,
      'run_api_not_configured',
      'Evaluations are not configured for this deployment.',
    );
  }

  const found = await store.find(agentId, version);
  if (found === null) return agentVersionNotFound(version);
  const agent = await runs.findAgent(principal, agentId);
  if (agent === null) {
    return problem(EVALUATION_PROBLEM_CODES.agent_not_found, 'agent_not_found', 'No such agent.');
  }

  const results: EvaluationCaseResult[] = [];
  for (const evalCase of cases) {
    const outcome = await runCase(evalCase, {
      runs,
      principal,
      agent,
      versionId: found.id,
      deadline,
    });
    if (outcome.kind === 'refused') {
      if (results.length === 0) return problem(outcome.status, outcome.code, outcome.message);
      results.push({ name: evalCase.name, passed: false, runId: null, failures: [outcome.code] });
      continue;
    }
    results.push(outcome.result);
  }

  const counts = score(results);
  const stored = await record(principal, {
    versionId: found.id,
    passed: counts.passed,
    total: counts.total,
    casesSnapshot: cases,
    results,
  });
  const body: EvaluationResource = {
    id: stored.id,
    agentId,
    version,
    ...counts,
    results,
    createdAt: stored.createdAt.toISOString(),
  };
  return { status: 201, body };
}

export interface CaseContext {
  readonly runs: RunApiEnvironment;
  readonly principal: Principal;
  readonly agent: AgentRef;
  /** The version every case's session pins. */
  readonly versionId: string;
  /** Epoch milliseconds after which nothing more is waited for. */
  readonly deadline: number;
}

const DEADLINE_EXCEEDED = 'deadline_exceeded' satisfies EvaluationCaseFailureCode;
const RUN_STREAM_FAILED = 'run_stream_failed' satisfies EvaluationCaseFailureCode;
const JUDGE_UNAVAILABLE = 'judge_unavailable' satisfies EvaluationCaseFailureCode;
const JUDGE_UNPARSEABLE = 'judge_unparseable' satisfies EvaluationCaseFailureCode;

export type CaseOutcome =
  | { readonly kind: 'scored'; readonly result: EvaluationCaseResult }
  | {
      readonly kind: 'refused';
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };

function failed(
  evalCase: EvalCase,
  runId: string | null,
  failures: readonly string[],
): CaseOutcome {
  return {
    kind: 'scored',
    result: { name: evalCase.name, passed: failures.length === 0, runId, failures },
  };
}

export async function runCase(evalCase: EvalCase, context: CaseContext): Promise<CaseOutcome> {
  const { runs, principal, agent, versionId, deadline } = context;
  if (Date.now() >= deadline) return failed(evalCase, null, [DEADLINE_EXCEEDED]);
  // The start (preflight, `openSession`, the run row) counts against the deadline too.
  const starting = startRunOnSession(runs, principal, agent, {
    prompt: evalCase.input,
    sessionId: null,
    modelOverride: null,
    agentVersionId: versionId,
  });
  const started = await beforeDeadline(starting, deadline);
  if (started === 'deadline') {
    // A start that lands after the deadline launches a run nobody waits for: stop it.
    void starting.then(
      (late) => {
        if (late.kind === 'started') stopAbandonedRun(runs, principal, late.run.id);
      },
      (cause: unknown) => {
        console.error('[evaluations] a case run started after the deadline failed', cause);
      },
    );
    return failed(evalCase, null, [DEADLINE_EXCEEDED]);
  }
  if (started.kind === 'refused') return started;
  const runId = started.run.id;

  const frames = await framesUntil(runs, runId, deadline);
  if (frames === 'deadline') {
    stopAbandonedRun(runs, principal, runId);
    return failed(evalCase, runId, [DEADLINE_EXCEEDED]);
  }
  if (frames === 'failed') return failed(evalCase, runId, [RUN_STREAM_FAILED]);
  const run = await runs.store.get(runId);
  const status = run?.status ?? 'missing';
  if (status !== 'completed') {
    // A failed run whose error carries a contract code (`model_credential_rejected`, …) reports
    // that code, so the cause is not lost behind `run_failed` (issue #661).
    const coded = status === 'failed' ? parseRunFailure(run?.error ?? null)?.code : null;
    return failed(evalCase, runId, [coded ?? `run_${status}`]);
  }

  const answer = finalAnswer(frames);
  const failures = [...checkCase(evalCase.expect, answer, toolCalls(frames))];
  if (evalCase.expect.judge !== undefined) {
    const prompt = judgePrompt(evalCase.expect.judge, evalCase.input, answer);
    failures.push(...(await judgeFailures(runs, principal, agent, versionId, prompt, deadline)));
  }
  return failed(evalCase, runId, failures);
}

/**
 * The run's agent frames once its stream ends at a terminal status, `'deadline'` when it has not
 * ended by `deadline`, or `'failed'` when reading it failed first. The stream is closed either way.
 */
async function framesUntil(
  runs: RunApiEnvironment,
  runId: string,
  deadline: number,
): Promise<readonly AgentFrame[] | 'deadline' | 'failed'> {
  const handle = await runs.store.openStream(runId, null);
  if (handle === null) return [];
  const frames: AgentFrame[] = [];
  let abandoned = false;
  const drained = (async () => {
    try {
      for await (const event of upgradeEventStream(handle.events, null)) {
        const frame = AgentFrameSchema.safeParse(event.data);
        if (frame.success) frames.push(frame.data);
      }
      return 'ended' as const;
    } catch (cause) {
      // A failed read fails this case only; the store's text stays in the log.
      const when = abandoned ? 'after it was abandoned ' : '';
      console.error(`[evaluations] reading run ${runId} ${when}failed`, cause);
      return 'failed' as const;
    }
  })();
  try {
    const outcome = await beforeDeadline(drained, deadline);
    if (outcome === 'ended') return frames;
    abandoned = outcome === 'deadline';
    return outcome;
  } finally {
    // After a deadline the abandoned read settles once the handle is closed.
    handle.close();
  }
}

/** What `pending` settles to, or `'deadline'` when `deadline` (epoch ms) passes first. */
async function beforeDeadline<T>(pending: Promise<T>, deadline: number): Promise<T | 'deadline'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([pending, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Interrupt a case's run the handler stopped waiting for, so it does not keep spending model
 * tokens after its case was failed. Best effort and in the background: the response does not wait
 * for it, and a failure is logged.
 */
function stopAbandonedRun(runs: RunApiEnvironment, principal: Principal, runId: string): void {
  const interrupt = runs.interruptRun;
  if (interrupt === undefined) return;
  const stopping = async () => {
    const run = await runs.store.get(runId);
    if (run === null || isTerminalRunStatus(run.status)) return;
    await interrupt(principal, run);
  };
  void stopping().catch((cause: unknown) => {
    console.error(`[evaluations] interrupting abandoned run ${runId} failed`, cause);
  });
}

async function judgeFailures(
  runs: RunApiEnvironment,
  principal: Principal,
  agent: AgentRef,
  versionId: string,
  prompt: string,
  deadline: number,
): Promise<readonly string[]> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return [DEADLINE_EXCEEDED];
  if (runs.judgeEvaluationCase === undefined) return [JUDGE_UNAVAILABLE];
  const signal = AbortSignal.timeout(remaining);
  let text: string;
  try {
    text = await runs.judgeEvaluationCase(principal, agent, versionId, prompt, signal);
  } catch (cause) {
    // Cut off by the request's deadline, not a provider outage.
    if (signal.aborted) return [DEADLINE_EXCEEDED];
    // The provider's text stays in the log: it can name an endpoint or echo a credential.
    console.error(`[evaluations] the judge call for agent ${agent.id} failed`, cause);
    return [JUDGE_UNAVAILABLE];
  }
  const verdict = parseJudgeVerdict(text);
  if (verdict.kind === 'invalid') return [JUDGE_UNPARSEABLE];
  return verdict.pass ? [] : [`judge: ${verdict.reason}`];
}

/** The part of a provider's Anthropic-format message the judge reads. */
const JudgeMessageSchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
});

/** The largest verdict the judge may write; a verdict is one short JSON object. */
const JUDGE_MAX_TOKENS = 256;

export interface ModelJudgeDependencies {
  /** The run ladder's model for version `agentVersionId` of the agent: `runPreflight.resolveModel`. */
  readonly resolveModel: (
    query: RunModelQuery & { readonly agentVersionId: string },
  ) => Promise<ModelResolution>;
  /** The connection and its credential, or `null` when the workspace has no such connection. */
  readonly connection: (
    workspaceId: string,
    connectionId: string,
  ) => Promise<ResolvedModelConnection | null>;
  readonly fetch?: typeof fetch;
}

/**
 * The judge as `installRunApi` wires it: one non-streaming message to the model the evaluated
 * version's runs resolve to, through the gateway's provider adapter for that connection. Throws on any
 * failure; {@link judgeFailures} turns that into `judge_unavailable`.
 */
export function createModelJudge(
  dependencies: ModelJudgeDependencies,
): NonNullable<RunApiEnvironment['judgeEvaluationCase']> {
  const adapters = new Map(
    createProviderRegistry(
      dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch },
    ).map((adapter) => [adapter.id, adapter]),
  );
  return async (principal, agent, agentVersionId, prompt, signal) => {
    const resolution = await dependencies.resolveModel({
      workspaceId: principal.workspaceId,
      agentId: agent.id,
      sessionId: null,
      modelOverride: null,
      agentVersionId,
    });
    if (!resolution.ok) throw new Error(`the judge model did not resolve (${resolution.code})`);
    const resolved = await dependencies.connection(principal.workspaceId, resolution.connectionId);
    if (resolved === null) throw new Error('the judge model connection did not resolve');
    const adapter = adapters.get(registryProviderId(resolved.connection.provider));
    if (adapter === undefined) throw new Error(`no adapter for ${resolved.connection.provider}`);
    // ponytail: judge calls skip the gateway process and are not metered in run_usage_records;
    // meter them through a judge token or a judge run when gateway metering of non-run calls exists.
    const response = await adapter.createMessage(
      {
        model: resolution.model,
        max_tokens: JUDGE_MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        providerId: adapter.id,
        credential: resolved.credential,
        requestId: randomUUID(),
        settings: resolved.connection.config,
        signal,
      },
    );
    if (!response.ok) throw new Error(`the judge provider answered ${String(response.status)}`);
    const message = JudgeMessageSchema.safeParse(await response.json());
    if (!message.success) throw new Error('the judge provider answer is not a message');
    return message.data.content
      .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
      .join('');
  };
}
