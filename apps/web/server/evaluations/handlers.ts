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
 *    `local` points at: `startRunOnSession` (`runs/service.ts`), wait for the
 *    run's stream to end, check the answer, then ask the judge if the case has one. A refused start of
 *    the first case answers that refusal and stores nothing; a later one fails only its case. A
 *    case with `expect.awaitsApproval` is scored where its run pauses for approval, and the run is
 *    then cancelled (ADR-0145): an evaluation never approves.
 * 4. Score, store, `201` with the evaluation.
 *
 * Synchronous, so it is bounded: at most `EVALUATION_CASE_LIMIT` cases and
 * {@link EVALUATION_DEADLINE_MS} for all of them, the running case and its judge included.
 */
import { randomUUID } from 'node:crypto';

import { log } from '../telemetry/logger';
import { errorNameOf } from '../telemetry/safe-error';

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

import { formatIssues, problem, type ApiResult } from '../http/result';
import { agentVersionNotFound } from '../agent-versions/problems';
import type { WorkspaceAgentVersionStore } from '../agent-versions/store';
import type { ModelResolution } from '../compose/run-request';
import type { RunModelQuery } from '../compose/run-preflight';
import { readBoundedJson } from '../http/json-transport';
import type { ResolvedModelConnection } from '../models/store';
import { upgradeEventStream } from '../runs/agent-frames';
import type {
  AgentRef,
  JudgeReply,
  RunLimitsOverride,
  RunPrincipal,
  RunApiEnvironment,
} from '../runs/environment';
import { startRunOnSession } from '../runs/service';
import { isTerminalRunStatus } from '../runs/store';
import { JUDGE_SYSTEM, judgePrompt, parseJudgeVerdict } from './judge';
import { checkCase, pausedCall, score, toolCalls, turnAnswer } from './score';

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
  /**
   * Limits every case's run starts under. They can only lower the policy's (`lowerLimits`). Set by
   * trusted in-process callers only: the route builds these dependencies without it and its body
   * schema refuses a `limits` key.
   */
  readonly limits?: RunLimitsOverride;
}

/** Score `raw`'s cases against a version of agent `agentId` and store the evaluation. */
export async function evaluateAgentVersion(
  raw: unknown,
  agentId: string,
  principal: RunPrincipal,
  dependencies: EvaluateAgentVersionDependencies,
): Promise<ApiResult> {
  const deadline = Date.now() + (dependencies.deadlineMs ?? EVALUATION_DEADLINE_MS);
  const parsed = CreateEvaluationRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return problem(
      EVALUATION_PROBLEM_CODES.invalid_body,
      'invalid_body',
      'The body is not an evaluation request.',
      formatIssues(parsed.error.issues),
    );
  }
  const { version, cases } = parsed.data;
  const { store, runs, limits } = dependencies;
  const record = runs?.recordEvaluation;
  if (runs === null || record === undefined) {
    return problem(
      EVALUATION_PROBLEM_CODES.run_api_not_configured,
      'run_api_not_configured',
      'Evaluations are not configured for this deployment.',
    );
  }

  // Under the Builder's limits a case run that cannot be stopped could later continue past them,
  // so nothing starts without a way to stop it.
  if (limits !== undefined && runs.interruptRun === undefined) return notStoppedProblem();

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
      ...(limits === undefined ? {} : { limits }),
    });
    if (outcome.kind === 'refused') {
      if (outcome.abort === true || results.length === 0) {
        return problem(outcome.status, outcome.code, outcome.message);
      }
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
  readonly principal: RunPrincipal;
  readonly agent: AgentRef;
  /** The version every case's session pins. */
  readonly versionId: string;
  /** Epoch milliseconds after which nothing more is waited for. */
  readonly deadline: number;
  /** Lowers every case's run limits; see {@link EvaluateAgentVersionDependencies.limits}. */
  readonly limits?: RunLimitsOverride;
}

const DEADLINE_EXCEEDED = 'deadline_exceeded' satisfies EvaluationCaseFailureCode;
const RUN_STREAM_FAILED = 'run_stream_failed' satisfies EvaluationCaseFailureCode;
const RUN_NOT_AWAITING_APPROVAL = 'run_not_awaiting_approval' satisfies EvaluationCaseFailureCode;
const JUDGE_UNAVAILABLE = 'judge_unavailable' satisfies EvaluationCaseFailureCode;
const JUDGE_UNPARSEABLE = 'judge_unparseable' satisfies EvaluationCaseFailureCode;

export type CaseOutcome =
  | { readonly kind: 'scored'; readonly result: EvaluationCaseResult }
  | {
      readonly kind: 'refused';
      readonly status: number;
      readonly code: string;
      readonly message: string;
      /** The evaluation ends with this refusal and stores nothing, whichever case it came from. */
      readonly abort?: true;
    };

/**
 * The Builder's code for a run that could not be stopped (`BUILDER_REFUSAL_CODES.trial_not_stopped`):
 * a run left going or paused would continue under the full policy budget if it were approved later,
 * because a continuation does not inherit lowered limits.
 */
const NOT_STOPPED = 'trial_not_stopped';

const NOT_STOPPED_MESSAGE = 'A case run could not be stopped, so the evaluation is not accepted.';

const notStoppedProblem = (): ApiResult => problem(409, NOT_STOPPED, NOT_STOPPED_MESSAGE);

/** The refusal that ends an evaluation run under limits when a case run could not be stopped. */
const NOT_STOPPED_OUTCOME = {
  kind: 'refused',
  status: 409,
  code: NOT_STOPPED,
  message: NOT_STOPPED_MESSAGE,
  abort: true,
} as const satisfies CaseOutcome;

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
  const { runs, principal, agent, versionId, deadline, limits } = context;
  if (Date.now() >= deadline) return failed(evalCase, null, [DEADLINE_EXCEEDED]);
  // The start (preflight, `openSession`, the run row) counts against the deadline too.
  const starting = startRunOnSession(runs, principal, agent, {
    prompt: evalCase.input,
    sessionId: null,
    modelOverride: null,
    agentVersionId: versionId,
    ...(limits === undefined ? {} : { limits }),
    ...(evalCase.outputSchema === undefined ? {} : { outputSchema: evalCase.outputSchema }),
  });
  const started = await beforeDeadline(starting, deadline);
  if (started === 'deadline') {
    // A start that lands after the deadline launches a run nobody waits for: stop it. The
    // response has gone by then, so this one stays in the background and a failure is logged.
    void starting.then(
      (late) => {
        if (late.kind === 'started') void stopRun(runs, principal, late.run.id);
      },
      (cause: unknown) => {
        log.error('[evaluations] a case run started after the deadline failed', {
          errorName: errorNameOf(cause),
        });
      },
    );
    return failed(evalCase, null, [DEADLINE_EXCEEDED]);
  }
  if (started.kind === 'refused') return started;
  const runId = started.run.id;
  try {
    return await settleCase(evalCase, context, runId);
  } catch (cause) {
    // A read that threw leaves the run going: stop it before the failure propagates.
    await stopRun(runs, principal, runId);
    throw cause;
  }
}

/** Waits for case `runId`, scores it and stops whatever is left of it. */
async function settleCase(
  evalCase: EvalCase,
  context: CaseContext,
  runId: string,
): Promise<CaseOutcome> {
  const { runs, principal, agent, versionId, deadline } = context;
  const frames = await framesUntil(runs, runId, deadline);
  if (frames === 'deadline' || frames === 'failed') {
    // Nobody is waiting for the run any more: it must not keep spending.
    const unstopped = await stopOrRefuse(context, runId);
    if (unstopped !== null) return unstopped;
    return failed(evalCase, runId, [frames === 'deadline' ? DEADLINE_EXCEEDED : RUN_STREAM_FAILED]);
  }
  const run = await runs.store.get(runId);
  const status = run?.status ?? 'missing';
  const awaitsApproval = evalCase.expect.awaitsApproval === true;
  // ADR-0145: a case that expects the pause passes the status check there, and fails if the run
  // completed without one. Anything else is judged as it is without the flag.
  const paused = awaitsApproval && status === 'awaiting_approval';
  if (awaitsApproval && status === 'completed') {
    return failed(evalCase, runId, [RUN_NOT_AWAITING_APPROVAL]);
  }
  // An evaluation never approves (D2.5). A run left paused (or still running) would continue
  // under the full policy budget if someone approved it later, because continuations do not
  // inherit lowered limits: stop it whatever the case expected. A terminal run is left alone.
  if (status !== 'completed') {
    const unstopped = await stopOrRefuse(context, runId);
    if (unstopped !== null) return unstopped;
  }
  if (status !== 'completed' && !paused) {
    // A failed run whose error carries a contract code (`model_credential_rejected`, …) reports
    // that code, so the cause is not lost behind `run_failed` (issue #661).
    const coded = status === 'failed' ? parseRunFailure(run?.error ?? null)?.code : null;
    return failed(evalCase, runId, [coded ?? `run_${status}`]);
  }

  const answer = turnAnswer(frames);
  const calls = paused
    ? [...toolCalls(frames), ...pausedCall(run?.pendingApproval)]
    : toolCalls(frames);
  const failures = [...checkCase(evalCase.expect, answer, calls, run?.output?.structured ?? null)];
  if (evalCase.expect.judge !== undefined) {
    const prompt = judgePrompt(evalCase.expect.judge, evalCase.input, answer);
    failures.push(
      ...(await judgeFailures(runs, principal, agent, versionId, runId, prompt, deadline)),
    );
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
      log.error(`[evaluations] reading run ${runId} ${when}failed`, {
        errorName: errorNameOf(cause),
      });
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
 * How long a response waits for an interrupt to finish. The response is already late (the
 * deadline has passed), ACA's ingress cuts it at 240 s and {@link EVALUATION_DEADLINE_MS} leaves 15 s
 * of that, so an interrupt that has not finished by then is reported as not having stopped the run.
 */
const STOP_WAIT_MS = 10_000;

/**
 * Interrupt a case's run the handler stopped waiting for, so it does not keep spending model
 * tokens after its case was failed, and read it again: `true` when it is terminal (or gone),
 * `false` when the run API cannot interrupt, the interrupt threw or took too long, or the run is
 * still not terminal after it. The failure is logged by its class name only.
 */
async function stopRun(
  runs: RunApiEnvironment,
  principal: RunPrincipal,
  runId: string,
): Promise<boolean> {
  const interrupt = runs.interruptRun;
  if (interrupt === undefined) return false;
  const stopping = (async () => {
    const run = await runs.store.get(runId);
    if (run === null || isTerminalRunStatus(run.status)) return true;
    await interrupt(principal, run);
    const after = await runs.store.get(runId);
    return after !== null && isTerminalRunStatus(after.status);
  })().catch((cause: unknown) => {
    log.error(`[evaluations] interrupting abandoned run ${runId} failed`, {
      errorName: errorNameOf(cause),
    });
    return false;
  });
  const stopped = await beforeDeadline(stopping, Date.now() + STOP_WAIT_MS);
  if (stopped === 'deadline' || !stopped) {
    log.error(`[evaluations] abandoned run ${runId} was not stopped`);
    return false;
  }
  return true;
}

/**
 * {@link stopRun}, answering the refusal that ends the evaluation when it failed under the
 * Builder's limits (`limits` set), `null` otherwise. The console route has no such limits, and a
 * run it could not stop is only logged.
 */
async function stopOrRefuse(context: CaseContext, runId: string): Promise<CaseOutcome | null> {
  const stopped = await stopRun(context.runs, context.principal, runId);
  return stopped || context.limits === undefined ? null : NOT_STOPPED_OUTCOME;
}

async function judgeFailures(
  runs: RunApiEnvironment,
  principal: RunPrincipal,
  agent: AgentRef,
  versionId: string,
  runId: string,
  prompt: string,
  deadline: number,
): Promise<readonly string[]> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return [DEADLINE_EXCEEDED];
  if (runs.judgeEvaluationCase === undefined) return [JUDGE_UNAVAILABLE];
  const signal = AbortSignal.timeout(remaining);
  let reply: JudgeReply;
  try {
    reply = await runs.judgeEvaluationCase(principal, agent, versionId, prompt, signal);
  } catch (cause) {
    // Cut off by the request's deadline, not a provider outage.
    if (signal.aborted) return [DEADLINE_EXCEEDED];
    // The provider's text stays in the log: it can name an endpoint or echo a credential.
    log.error(`[evaluations] the judge call for agent ${agent.id} failed`, {
      errorName: errorNameOf(cause),
    });
    return [JUDGE_UNAVAILABLE];
  }
  const verdict = parseJudgeVerdict(reply.text);
  if (verdict.kind === 'invalid') {
    // The reply is not logged: it can quote the agent's answer, and so an attack or a secret.
    log.warn('[evaluations] the judge reply was not a verdict', {
      runId,
      stopReason: knownStopReason(reply.stopReason),
    });
    return [JUDGE_UNPARSEABLE];
  }
  return verdict.pass ? [] : [`judge: ${verdict.reason}`];
}

/** The stop reasons a log line may name; anything else a provider sends is logged as `other`. */
// A log allowlist, not the list of stop reasons a provider contract allows.
const STOP_REASONS = new Set([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'pause_turn',
  'refusal',
]);

function knownStopReason(stopReason: string | null): string {
  if (stopReason === null) return 'none';
  return STOP_REASONS.has(stopReason) ? stopReason : 'other';
}

/** The part of a provider's Anthropic-format message the judge reads. */
const JudgeMessageSchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  stop_reason: z.string().nullish(),
});

/**
 * The most the judge may write. A verdict is one short JSON object, but a model that reasons in
 * prose first was cut off at 256 (#1848), and a verdict cut off is not a verdict.
 */
const JUDGE_MAX_TOKENS = 1024;

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
 * The judge as `wireRunApi` (`composition/wiring/run-api.ts`) wires it into
 * `ApplicationContext.runs`: one non-streaming message to the model the evaluated version's runs
 * resolve to, through the gateway's provider adapter for that connection. Throws on any failure;
 * {@link judgeFailures} turns that into `judge_unavailable`.
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
    const providerId = registryProviderId(resolved.connection.provider);
    const adapter = adapters.get(providerId);
    if (adapter === undefined) throw new Error(`no adapter for ${resolved.connection.provider}`);
    // ponytail: judge calls skip the gateway process and are not metered in run_usage_records;
    // meter them through a judge token or a judge run when gateway metering of non-run calls exists.
    const response = await adapter.createMessage(
      {
        model: resolution.model,
        max_tokens: JUDGE_MAX_TOKENS,
        system: JUDGE_SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        providerId,
        credential: resolved.credential,
        requestId: randomUUID(),
        settings: resolved.connection.config,
        signal,
      },
    );
    if (!response.ok) throw new Error(`the judge provider answered ${String(response.status)}`);
    const message = JudgeMessageSchema.safeParse(await response.json());
    if (!message.success) throw new Error('the judge provider answer is not a message');
    return {
      text: message.data.content
        .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
        .join(''),
      stopReason: message.data.stop_reason ?? null,
    };
  };
}
