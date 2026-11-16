/**
 * One execution of one recipe run (issue #1513): the `step` function, the step-bound SDK client,
 * and how a step's run is waited on. `recipe-runner.ts` claims the lease and calls
 * {@link executeRecipeRun}; everything here runs while that lease is held.
 *
 * The rules: a completed step returns its stored value without calling its function; a step
 * starts at most one run, whose idempotency key is `recipe:<recipeRunId>:<stepKey>`; its run id is
 * recorded before the step waits; a run that stops for approval suspends the recipe; a run that
 * fails or is cancelled fails the step with its public code, never provider text.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import type { RunResource } from '@indx-workspace/contracts/runs';
import {
  ApiProblemError,
  runFailure,
  TransportError,
  type AgentWorkspaceClient,
  type RunResult,
} from '@indx-workspace/sdk';
import { z } from 'zod';

import { AppStoreError } from '../db/errors.js';
import type { RecipeRunRecord, RecipeStepRecord, RecipeStore } from '../db/recipe-port.js';
import {
  STEP_KEY_PATTERN,
  type DefinedRecipe,
  type Json,
  type RecipeClient,
  type RecipeContext,
  type RecipeRunStart,
  type RecipeStartInput,
  type StepFn,
  type StepOptions,
} from '../recipe.js';
import { RecipeError, RecipeStepFailed, RecipeSuspended } from './recipe-errors.js';
import {
  assertActingFor,
  recipeStoreOfRun,
  type ActingStep,
  type RecipeRecords,
} from './recipe-runner-store.js';

/** The stored reason of a paused run cancelled because nobody decided in time (ADR-0145 D2.4). */
const APPROVAL_EXPIRED_PREFIX = 'approval_expired';

/**
 * A failure of the app's own storage or of the network, after which the recipe is left as it is
 * for `resume()` to execute again: nothing about the recipe itself was wrong.
 */
class RecipeInterrupted extends Error {
  override readonly name = 'RecipeInterrupted';
}

/** Whether `error` leaves the recipe for a later execution rather than failing it. */
function isInterruption(error: unknown): boolean {
  if (error instanceof RecipeInterrupted || error instanceof TransportError) return true;
  if (error instanceof ApiProblemError) return error.status >= 500 || error.status === 429;
  // The app's own database failed under a store call: nothing about the recipe was wrong.
  if (error instanceof AppStoreError) return error.code === 'internal_error';
  return error instanceof Error && error.name === 'AbortError';
}

/** `store` with every failure turned into a {@link RecipeInterrupted}, its cause kept. */
export function interruptibleStore(store: RecipeStore): RecipeStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) =>
        Promise.resolve()
          .then(() => (value as (...input: unknown[]) => unknown).apply(target, args))
          .catch((cause: unknown) => {
            if (cause instanceof RangeError) throw cause;
            throw new RecipeInterrupted('the recipe store failed', { cause });
          });
    },
  });
}

/** Whether a paused run ended because its approval expired. */
export function approvalExpired(run: RunResource): boolean {
  return run.status === 'cancelled' && (run.error ?? '').startsWith(APPROVAL_EXPIRED_PREFIX);
}

/** The public code a run that did not complete fails its step with. */
function failureCodeOf(run: RunResource): string {
  if (run.status === 'failed') return runFailure(run)?.code ?? 'run_failed';
  return approvalExpired(run) ? 'approval_expired' : 'run_cancelled';
}

/** What one execution needs from the runner. */
export interface ExecutionContext {
  readonly client: AgentWorkspaceClient;
  readonly store: RecipeStore;
  readonly now: () => Date;
  readonly signal: AbortSignal;
  /** The app's stores and member directory, for the recipe's `store`; absent, `store` refuses. */
  readonly records?: RecipeRecords;
}

/** The step a call runs in, so `aw.runs.start` knows its key. */
interface StepFrame {
  readonly recipeRunId: string;
  readonly key: string;
  readonly row: RecipeStepRecord;
  /** The member a schedule's step acts for (`actingFor`), or `null`. */
  readonly actingFor: string | null;
  runId: string | null;
  schema: z.ZodType | undefined;
  starting: boolean;
  /** Whether this execution's `runs.start` answered, so `runId` is the run this step started. */
  started: boolean;
  settled: Promise<RunResult<unknown>> | null;
}

const frames = new AsyncLocalStorage<StepFrame>();

/** The idempotency key of the one run a step may start. */
function stepIdempotencyKey(recipeRunId: string, key: string): string {
  return `recipe:${recipeRunId}:${key}`;
}

/** Waits on the step's run (its continuation once decided) and reads its outcome, once. */
function settle(context: ExecutionContext, frame: StepFrame): Promise<RunResult<unknown>> {
  frame.settled ??= (async () => {
    const runId = frame.row.continuationRunId ?? frame.runId;
    if (runId === null) throw new Error('settle() called before the step started a run');
    const result: RunResult<unknown> =
      frame.schema === undefined
        ? await context.client.runs.result(runId, { signal: context.signal })
        : await context.client.runs.result(runId, { schema: frame.schema, signal: context.signal });
    const { run } = result;
    if (run.status === 'completed') return result;
    if (run.status === 'awaiting_approval') {
      await context.store.suspendStep(frame.recipeRunId, frame.key);
      await context.store.setRunStatus(frame.recipeRunId, 'waiting', null, context.now());
      throw new RecipeSuspended();
    }
    throw new RecipeStepFailed(failureCodeOf(run));
  })();
  return frame.settled;
}

/**
 * `aw.runs.start` inside a step: the step's key, the person, and one run at most.
 *
 * shortcut: recipe steps run with the app key's authority (`AW_APP_API_KEY`) attributed to the
 * person by `subject`, which the platform signs unchecked (ADR-0142 D2), so a person-triggered
 * recipe is not limited to the agents that person may run (access ∩ agents.write); upgrade by a
 * token exchange or a delegated grant captured when the recipe starts, so each step's run start is
 * decided as the person.
 */
async function startInStep(
  context: ExecutionContext,
  person: RecipeContext<unknown>['person'],
  agentId: string,
  input: RecipeStartInput,
): Promise<RecipeRunStart> {
  const frame = frames.getStore();
  if (frame === undefined) {
    throw new RecipeError('run_started_outside_step', 'aw.runs.start may be called only in a step');
  }
  if (frame.starting) {
    throw new RecipeError('step_starts_two_runs', `step "${frame.key}" started a second run`);
  }
  frame.starting = true;
  let run: RunResource;
  try {
    ({ run } = await context.client.runs.start(
      agentId,
      {
        ...input,
        idempotencyKey: stepIdempotencyKey(frame.recipeRunId, frame.key),
        ...subjectOf(person, frame),
      },
      { signal: context.signal },
    ));
  } catch (error) {
    if (error instanceof ApiProblemError && error.code === 'run_idempotency_conflict') {
      throw new RecipeError(
        'recipe_step_input_changed',
        `step "${frame.key}" started its run again with another input`,
      );
    }
    throw error;
  }
  if (frame.row.runId !== run.id) {
    await context.store.recordStepRun(frame.recipeRunId, frame.key, run.id);
  }
  frame.runId = run.id;
  frame.started = true;
  frame.schema = input.outputSchema instanceof z.ZodType ? input.outputSchema : undefined;
  const result: PromiseLike<RunResult<unknown>> = {
    then: (onFulfilled, onRejected) => settle(context, frame).then(onFulfilled, onRejected),
  };
  return { run, result };
}

/** The `subject` a step's run asserts: the recipe's person, or the member the step acts for. */
function subjectOf(
  person: RecipeContext<unknown>['person'],
  frame: StepFrame,
): { readonly subject?: string } {
  const subject = person?.principalId ?? frame.actingFor;
  return subject === null ? {} : { subject };
}

/** The app's client with `runs.start` bound to the current step. */
function recipeClientOf(
  context: ExecutionContext,
  person: RecipeContext<unknown>['person'],
): RecipeClient {
  const runs = new Proxy(context.client.runs, {
    get(target, property) {
      if (property === 'start') {
        return (agentId: string, input: RecipeStartInput) =>
          startInStep(context, person, agentId, input);
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { ...context.client, runs } as unknown as RecipeClient;
}

/** A JSON copy of a step's value. @throws {RecipeError} for one that is not JSON. */
function jsonOf(value: unknown): Json {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as Json;
  } catch (cause) {
    throw new RecipeError('step_output_not_json', 'a step must resolve to a JSON value', { cause });
  }
}

/** The step failure `error` (thrown in a step's function) records: its public code. */
function stepFailureOf(error: unknown): RecipeError | RecipeStepFailed {
  if (error instanceof RecipeError || error instanceof RecipeStepFailed) return error;
  if (error instanceof AppStoreError) return new RecipeStepFailed(error.code, { cause: error });
  return new RecipeStepFailed('step_failed', { cause: error });
}

/** The `step` of one execution of `recipeRunId`, run for `person`. */
function stepFnOf(
  context: ExecutionContext,
  recipeRunId: string,
  person: RecipeContext<unknown>['person'],
): StepFn {
  const used = new Set<string>();
  const { store } = context;
  const step = async (
    key: string,
    fn: () => Promise<unknown>,
    options: StepOptions = {},
  ): Promise<Json> => {
    if (!STEP_KEY_PATTERN.test(key)) {
      throw new RecipeError(
        'step_key_invalid',
        'a step key must match ^[a-z0-9][a-z0-9._-]{0,63}$',
      );
    }
    if (used.has(key)) throw new RecipeError('step_key_reused', `step "${key}" ran twice`);
    used.add(key);
    const existing = await store.getStep(recipeRunId, key);
    if (existing?.status === 'completed') return existing.output;
    if (existing?.status === 'failed') throw new RecipeStepFailed(existing.error ?? 'step_failed');
    if (existing?.status === 'awaiting_approval') {
      await store.setRunStatus(recipeRunId, 'waiting', null, context.now());
      throw new RecipeSuspended();
    }
    const row = existing ?? (await store.upsertStepRunning(recipeRunId, key, context.now()));
    const frame: StepFrame = {
      recipeRunId,
      key,
      row,
      actingFor: typeof options.actingFor === 'string' ? options.actingFor.toLowerCase() : null,
      runId: row.runId,
      schema: undefined,
      starting: false,
      started: false,
      settled: null,
    };
    try {
      if (options.actingFor !== undefined) {
        await assertActingFor(context.records, person, options.actingFor);
      }
      const value = await frames.run(frame, fn);
      const result = frame.runId === null ? null : await settle(context, frame);
      const output = jsonOf(
        value === undefined && result !== null ? (result.output ?? result.text) : value,
      );
      await store.completeStep(recipeRunId, key, output, context.now());
      return output;
    } catch (error) {
      if (error instanceof RecipeSuspended || isInterruption(error)) throw error;
      const failure = stepFailureOf(error);
      await store.failStep(recipeRunId, key, failure.code, context.now());
      throw failure;
    }
  };
  return step as StepFn;
}

/**
 * The step a `store` call is made in: its `actingFor`, and its run once this execution started
 * it (a run recorded by an earlier, interrupted execution counts only once `runs.start` answers
 * it again), so a write is allowed at the same point on every execution.
 */
function actingStep(): ActingStep | undefined {
  const frame = frames.getStore();
  if (frame === undefined) return undefined;
  return { actingFor: frame.actingFor, runId: frame.started ? frame.runId : null };
}

/** How one execution of a recipe run ended. */
export type ExecutionOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'suspended' }
  | { readonly kind: 'interrupted'; readonly cause: unknown }
  | { readonly kind: 'failed'; readonly code: string; readonly cause: unknown };

/** The public code a recipe run that threw `error` fails with. */
function failureOf(error: unknown): ExecutionOutcome {
  if (error instanceof RecipeSuspended) return { kind: 'suspended' };
  if (isInterruption(error)) return { kind: 'interrupted', cause: error };
  if (
    error instanceof RecipeError ||
    error instanceof RecipeStepFailed ||
    error instanceof AppStoreError
  ) {
    return { kind: 'failed', code: error.code, cause: error };
  }
  return { kind: 'failed', code: 'recipe_failed', cause: error };
}

/**
 * Runs `recipe` for the claimed `run` to its end, its suspension or its interruption, and records
 * the recipe run's status. The caller holds the lease and frees it.
 */
export async function executeRecipeRun(
  context: ExecutionContext,
  recipe: DefinedRecipe,
  run: RecipeRunRecord,
): Promise<ExecutionOutcome> {
  let outcome: ExecutionOutcome;
  try {
    const parsed =
      recipe.input === null
        ? { success: true as const, data: run.input }
        : recipe.input.safeParse(run.input);
    if (!parsed.success) throw new RecipeError('recipe_input_invalid');
    const person = run.startedBy === null ? null : { principalId: run.startedBy };
    await recipe.run({
      aw: recipeClientOf(context, person),
      input: parsed.data,
      step: stepFnOf(context, run.id, person),
      person,
      recipeRunId: run.id,
      store: recipeStoreOfRun(context.records, person, actingStep),
    });
    outcome = { kind: 'completed' };
  } catch (error) {
    outcome = failureOf(error);
  }
  if (outcome.kind === 'completed') {
    await context.store.setRunStatus(run.id, 'completed', null, context.now());
  } else if (outcome.kind === 'failed') {
    await context.store.setRunStatus(run.id, 'failed', outcome.code, context.now());
  }
  return outcome;
}
