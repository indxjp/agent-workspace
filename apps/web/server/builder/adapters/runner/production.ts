import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { BUILDER_DEFAULT_LIMITS } from '@indx-workspace/contracts/builder';
import { EvaluationResourceSchema } from '@indx-workspace/contracts/evaluations';
import { RUN_IDEMPOTENCY_PROBLEM_CODES } from '@indx-workspace/contracts/runs';

import { isUuid } from '../../../agents/contract';
import { agentNotFound, refuseBuiltinWrite } from '../../../agents/handlers';
import { ownershipOf, type RunOwnershipPrincipal } from '../../../agents/run-ownership';
import { agentVersionNotFound } from '../../../agent-versions/problems';
import type { AgentVersionStoreProvider } from '../../../agent-versions/store';
import type { AgentStoreProvider } from '../../../agents/store';
import { evaluateAgentVersion, EVALUATION_DEADLINE_MS } from '../../../evaluations/handlers';
import type { ApiResult } from '../../../http/result';
import type { Role } from '../../../rbac/roles';
import type { RunApiEnvironment, RunPrincipal } from '../../../runs/environment';
import { MAX_IDEMPOTENCY_KEY_CHARS } from '../../../runs/api';
import { MAX_PROMPT_CHARS, startRunOnSession } from '../../../runs/service';
import {
  IdempotencyKeyTakenError,
  isStoppedRunStatus,
  isTerminalRunStatus,
  type RunRecord,
} from '../../../runs/store';
import { log } from '../../../telemetry/logger';
import type { EvalResult, RunnerPort, TrialResult } from '../../ports';
import { mayEvaluate, mayRun } from '../checker/access';
import { failureOf } from '../checker/production';

export interface RunnerDependencies {
  readonly agents: AgentStoreProvider;
  readonly versions: AgentVersionStoreProvider;
  /** The deployment's run API, or `null` when it has none (the evaluation then answers 503). */
  readonly runApi: () => RunApiEnvironment | null;
  /** Who was granted which agent; without it only an agent's owner (and the built-in Builder) is run-able. */
  readonly grants?: {
    forWorkspace(workspaceId: string): {
      hasGrant(agentId: string, userId: string): Promise<boolean>;
    };
  };
}

export const NO_CALLER = {
  ok: false,
  code: 'no_caller',
  message: 'This run has no person behind it, so a version cannot be evaluated or tried.',
} satisfies EvalResult;

/** What `agent-versions/http.ts` answers for an id that is not a UUID. */
export const INVALID_AGENT_ID = {
  ok: false,
  code: 'invalid_agent_id',
  message: 'The agent id is not a UUID.',
} satisfies EvalResult;

export const FORBIDDEN = {
  ok: false,
  code: 'forbidden',
  message: 'The person may not evaluate this agent.',
} satisfies EvalResult;

export const FORBIDDEN_TO_RUN = {
  ok: false,
  code: 'forbidden',
  message: 'The person may not run this agent.',
} satisfies TrialResult;

/** The run route's idempotency refusals, named once here and checked against the contracts' vocabulary. */
export const IDEMPOTENCY_CODES = {
  conflict: 'run_idempotency_conflict',
  invalidKey: 'invalid_idempotency_key',
} as const satisfies Record<string, keyof typeof RUN_IDEMPOTENCY_PROBLEM_CODES>;

const RUN_IDEMPOTENCY_CONFLICT = {
  ok: false,
  code: IDEMPOTENCY_CODES.conflict,
  message: 'This idempotency key was already used with a different trial; send a new key.',
} satisfies TrialResult;

/**
 * Marks a Builder trial's idempotency key in the run store's per-principal key space it shares with
 * the run route. A header value is a byte string, so the route can never send a character above
 * U+00FF: no `Idempotency-Key` it accepts can equal a key with this prefix.
 */
export const BUILDER_TRIAL_KEY_PREFIX = 'builder\u2192trial:';

/** The refusals a trial makes from its arguments alone, before any store is read. */
export function trialArgumentRefusal(
  agentId: string,
  input: string,
  budgetUsd: number,
  idempotencyKey: string,
): TrialResult | null {
  if (!isUuid(agentId)) return INVALID_AGENT_ID;
  if (input.trim() === '' || input.length > MAX_PROMPT_CHARS) {
    return {
      ok: false,
      code: 'invalid_trial_input',
      message: `The trial input must be 1 to ${String(MAX_PROMPT_CHARS)} characters.`,
    };
  }
  const key = idempotencyKey.trim();
  if (key === '' || key.length > MAX_IDEMPOTENCY_KEY_CHARS) {
    return {
      ok: false,
      code: IDEMPOTENCY_CODES.invalidKey,
      message: `The idempotency key must be 1 to ${String(MAX_IDEMPOTENCY_KEY_CHARS)} characters.`,
    };
  }
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    return {
      ok: false,
      code: 'invalid_run_limits',
      message: 'The trial budget must be a positive number of US dollars.',
    };
  }
  return null;
}

/** The most one trial may spend, whatever it asked for; the agent's own budget can only lower it further. */
export const cappedBudget = (budgetUsd: number): number =>
  Math.min(budgetUsd, BUILDER_DEFAULT_LIMITS.trialBudgetUsd);

/** The answer cut to the Builder's tool-output limit on a whole character. */
export function capOutput(text: string): { readonly output: string; readonly truncated: boolean } {
  const bytes = Buffer.from(text);
  const max = BUILDER_DEFAULT_LIMITS.toolOutputMaxBytes;
  if (bytes.length <= max) return { output: text, truncated: false };
  let end = max;
  // A UTF-8 continuation byte first past the cut means the cut is inside a character: back up to its start.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { output: bytes.subarray(0, end).toString('utf8'), truncated: true };
}

/** What identifies a trial request, so a key reused for another one is refused rather than replayed. */
export const trialRequestHash = (
  agentId: string,
  version: number,
  input: string,
  budgetUsd: number,
): string =>
  createHash('sha256')
    .update(JSON.stringify({ agentId, version, input, budgetUsd: cappedBudget(budgetUsd) }))
    .digest('hex');

/** 201 is the stored evaluation; a 4xx is the route's `{error}` passed through. Anything else is not the model's to see. */
function toEvalResult(result: ApiResult): EvalResult {
  const evaluation = EvaluationResourceSchema.safeParse(result.body);
  if (result.status === 201 && evaluation.success) return { ok: true, evaluation: evaluation.data };
  return refusalOf(result, 'evaluations');
}

/** A 4xx `{error}` as the refusal the model sees; any other status is not the model's to see. */
export function refusalOf(
  result: ApiResult,
  handler = 'run',
): { ok: false; code: string; message: string } {
  const failed = failureOf(result);
  if (failed !== null) return { ok: false, code: failed.code, message: failed.message };
  throw new Error(`The ${handler} handler answered ${String(result.status)}.`);
}

const runPrincipalOf = (
  workspaceId: string,
  principal: RunOwnershipPrincipal & { readonly role: Role },
): RunPrincipal => ({
  principalId: principal.principalId,
  ownerPrincipalId: principal.ownerPrincipalId,
  userId: principal.userId,
  workspaceId,
  role: principal.role,
  scope: null,
});

/**
 * A trial that could not be stopped. An approval continuation does not inherit the trial's limits,
 * so a run left going or paused could later continue under the full policy budget: it is refused
 * rather than answered.
 */
const TRIAL_NOT_STOPPED = {
  ok: false,
  code: 'trial_not_stopped',
  message: 'The trial run could not be stopped, so its result is not accepted.',
} satisfies TrialResult;

const POLL_MS = 100;

/**
 * The run once it has stopped, or `null` when it could not be stopped. A run still going at the
 * evaluation deadline, or paused for an approval nobody here will give, is interrupted so a trial
 * never spends on past its answer; the run is read again after the interrupt, and an interrupt that
 * threw or left the run short of a terminal status is a run that did not stop.
 * ponytail: polls the run row; read its event stream instead when 100 ms of latency matters.
 */
async function stoppedRun(
  runs: RunApiEnvironment,
  principal: RunPrincipal,
  runId: string,
): Promise<RunRecord | null> {
  const deadline = Date.now() + EVALUATION_DEADLINE_MS;
  for (;;) {
    const run = await runs.store.get(runId);
    if (run === null) throw new Error(`Run ${runId} is missing from the run store.`);
    if (isTerminalRunStatus(run.status)) return run;
    if (isStoppedRunStatus(run.status) || Date.now() >= deadline) {
      try {
        if (runs.interruptRun === undefined) return null;
        await runs.interruptRun(principal, run);
      } catch (cause) {
        log.error(`[builder] interrupting trial run ${runId} failed`, {
          errorName: cause instanceof Error ? cause.name : typeof cause,
        });
        return null;
      }
      const after = await runs.store.get(runId);
      return after !== null && isTerminalRunStatus(after.status) ? after : null;
    }
    await sleep(POLL_MS);
  }
}

async function trialResult(
  runs: RunApiEnvironment,
  principal: RunPrincipal,
  runId: string,
): Promise<TrialResult> {
  const run = await stoppedRun(runs, principal, runId);
  if (run === null) return TRIAL_NOT_STOPPED;
  return {
    ok: true,
    runId,
    status: run.status,
    ...capOutput(run.output?.text ?? ''),
    costUsd: Number(run.costUsd ?? 0),
  };
}

/**
 * `RunnerPort.evaluate` makes the call `POST /api/agents/:id/evaluations` makes, as the caller: the
 * route's ownership and RBAC check first, then its own handler, so the runs it starts are the
 * caller's and nothing is wider than the console allows. `trial` does the same for
 * `POST /api/agents/:id/runs`, with its budget lowered.
 */
export function createRunner(deps: RunnerDependencies): RunnerPort {
  return {
    async evaluate(ctx, agentId, version, cases) {
      if (ctx.caller.kind === 'none') return NO_CALLER;
      const { principal } = ctx.caller;
      if (!isUuid(agentId)) return INVALID_AGENT_ID;
      const agent = await deps.agents.forWorkspace(ctx.workspaceId).get(agentId);
      if (agent === null) return toEvalResult(agentNotFound());
      const readOnly = refuseBuiltinWrite(agent, 'evaluate');
      if (readOnly !== null) return toEvalResult(readOnly);
      if (!mayEvaluate(principal, agent)) return FORBIDDEN;
      const store = await deps.versions.forWorkspace(ctx.workspaceId);
      if (store === null) {
        throw new Error('The version store does not resolve a workspace RBAC verified.');
      }
      return toEvalResult(
        await evaluateAgentVersion(
          { version, cases },
          agent.id,
          runPrincipalOf(ctx.workspaceId, principal),
          {
            store,
            runs: deps.runApi(),
            // ponytail: the contracts trial cap, not ports.policy.limits; pass the policy's trialBudgetUsd once workspaces can lower it.
            limits: { maxBudgetUsd: BUILDER_DEFAULT_LIMITS.trialBudgetUsd },
          },
        ),
      );
    },

    async trial(ctx, agentId, version, input, budgetUsd, idempotencyKey) {
      if (ctx.caller.kind === 'none') return NO_CALLER;
      const { principal } = ctx.caller;
      const invalid = trialArgumentRefusal(agentId, input, budgetUsd, idempotencyKey);
      if (invalid !== null) return invalid;
      const agent = await deps.agents.forWorkspace(ctx.workspaceId).get(agentId);
      if (agent === null) return refusalOf(agentNotFound());
      const readOnly = refuseBuiltinWrite(agent, 'create-version');
      if (readOnly !== null) return refusalOf(readOnly);
      const ownership = await ownershipOf(
        principal,
        agent,
        deps.grants?.forWorkspace(ctx.workspaceId),
      );
      if (!mayRun(principal, agent, ownership)) return FORBIDDEN_TO_RUN;
      const runs = deps.runApi();
      if (runs === null) throw new Error('The run API is not configured.');
      // Without a way to stop the run nothing may start: see TRIAL_NOT_STOPPED.
      if (runs.interruptRun === undefined) return TRIAL_NOT_STOPPED;
      const versions = await deps.versions.forWorkspace(ctx.workspaceId);
      if (versions === null) {
        throw new Error('The version store does not resolve a workspace RBAC verified.');
      }
      // A version number is a positive integer column: anything else names no version.
      const found =
        Number.isInteger(version) && version > 0 ? await versions.find(agent.id, version) : null;
      if (found === null) return refusalOf(agentVersionNotFound(version));
      const runPrincipal = runPrincipalOf(ctx.workspaceId, principal);
      const target = await runs.findAgent(runPrincipal, agent.id);
      if (target === null) return refusalOf(agentNotFound());

      const idempotency = {
        principalId: principal.principalId,
        key: `${BUILDER_TRIAL_KEY_PREFIX}${idempotencyKey.trim()}`,
        requestHash: trialRequestHash(agent.id, version, input, budgetUsd),
      };
      const replay = async (): Promise<TrialResult | null> => {
        const held = await runs.store.findByIdempotencyKey(
          ctx.workspaceId,
          idempotency.principalId,
          idempotency.key,
        );
        if (held === null) return null;
        return held.requestHash === idempotency.requestHash
          ? trialResult(runs, runPrincipal, held.run.id)
          : RUN_IDEMPOTENCY_CONFLICT;
      };
      const earlier = await replay();
      if (earlier !== null) return earlier;

      let started: Awaited<ReturnType<typeof startRunOnSession>>;
      try {
        started = await startRunOnSession(runs, runPrincipal, target, {
          prompt: input,
          sessionId: null,
          modelOverride: null,
          agentVersionId: found.id,
          idempotency,
          limits: { maxBudgetUsd: cappedBudget(budgetUsd) },
        });
      } catch (error) {
        // Another start with this key committed first: answer with its run.
        const raced = error instanceof IdempotencyKeyTakenError ? await replay() : null;
        if (raced === null) throw error;
        return raced;
      }
      if (started.kind === 'refused') {
        return { ok: false, code: started.code, message: started.message };
      }
      return trialResult(runs, runPrincipal, started.run.id);
    },
  };
}
