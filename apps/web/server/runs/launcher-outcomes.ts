import { EngineIdSchema } from '@indx-workspace/contracts/engines';
import {
  OUTPUT_SCHEMA_UNSATISFIED,
  OUTPUT_SCHEMA_UNSATISFIED_MESSAGE,
} from '@indx-workspace/contracts/runs';
import { type RelayOutcome } from './relay';
import { RUN_STATUS_EVENT, RUN_WARNING_EVENT } from './sse';
import { publicRunFailure } from './failures';
import { DomainError } from '../errors';
import type { LaunchContext } from './environment';
import type { ApprovalCall, RunOutput, RunStatus, RunStore } from './store';
import type { RuntimeLaunchTarget } from '../compose/runtime-profile';
import { type RunnerLauncherOptions } from './launcher-contract';
import { STOPPED_WHILE_LIVE } from './launcher-cancellation';
export { STOPPED_WHILE_LIVE, type HeldRunWatch, watchHeldRun } from './launcher-cancellation';

function publicRelayFailure(
  outcome: Extract<RelayOutcome, { kind: 'failed' | 'cancelled' }>,
): string {
  return publicRunFailure(new Error(outcome.reason), {
    operation: 'runtime-run-outcome',
    failureKind: 'upstream',
    publicMessage:
      outcome.kind === 'cancelled'
        ? 'The run was interrupted.'
        : 'The runtime reported a run failure.',
  });
}

/** The public message for a runtime outcome: a coded one the composition root names, or the generic one. */
function publicOutcomeMessage(
  options: Pick<RunnerLauncherOptions, 'codeRuntimeFailure'>,
  context: LaunchContext,
  outcome: Extract<RelayOutcome, { kind: 'failed' | 'cancelled' }>,
): string {
  // ADR-0143: the engine's reason is already fixed text, but the stored one is the contract's.
  if (outcome.kind === 'failed' && outcome.reason.startsWith(`${OUTPUT_SCHEMA_UNSATISFIED}:`)) {
    return `${OUTPUT_SCHEMA_UNSATISFIED}: ${OUTPUT_SCHEMA_UNSATISFIED_MESSAGE}`;
  }
  const coded =
    outcome.kind === 'failed' ? options.codeRuntimeFailure?.(context, outcome.reason) : null;
  return coded ?? publicRelayFailure(outcome);
}

/** Write a terminal status as both an event and a record update, in that order. */
export async function conclude(conclusion: {
  readonly store: RunStore;
  readonly context: LaunchContext;
  readonly status: RunStatus;
  readonly failureMessage: string | null;
  readonly startedAtMs: number;
  readonly options: RunnerLauncherOptions;
  readonly target: RuntimeLaunchTarget | undefined;
  readonly output?: RunOutput | null;
  readonly approval?: ApprovalCall | null;
}): Promise<void> {
  const {
    store,
    context,
    status,
    failureMessage,
    startedAtMs,
    options,
    target,
    output = null,
    approval = null,
  } = conclusion;
  const runId = context.run.id;
  await releaseRunSandboxesBestEffort(options, context, target);
  // A pause is a stop, not an ending (ADR-0145): the run keeps its sandbox-free state and waits.
  if (approval === null) await store.finish(runId, status, failureMessage, true, output);
  else await store.awaitApproval(runId, approval);
  // Read back after `finish`: whatever the gateway's (separately-processed) usage settlement has
  // landed by now is what this terminal measurement reports. `Number.isFinite` is the positive
  // assertion — an unparsable or non-numeric stored value reports `null` rather than `NaN`.
  const settled = await store.get(runId);
  const settledCost = settled?.costUsd === undefined ? null : Number(settled.costUsd);
  options.onRunFinished?.({
    runId,
    workspaceId: context.principal.workspaceId,
    agentId: context.agent.id,
    status,
    durationMs: Math.max(0, Date.now() - startedAtMs),
    costUsd: settledCost !== null && Number.isFinite(settledCost) ? settledCost : null,
  });
}

/** Release the run's provider resources; a failure goes to server diagnostics, never to the caller. */
async function releaseRunSandboxesBestEffort(
  options: Pick<RunnerLauncherOptions, 'releaseRunSandboxes'>,
  context: LaunchContext,
  target: RuntimeLaunchTarget | undefined,
): Promise<void> {
  if (target === undefined) return;
  try {
    await options.releaseRunSandboxes?.(context, target);
  } catch (cause) {
    publicRunFailure(cause, {
      operation: 'release-run-sandboxes',
      failureKind: 'upstream',
      publicMessage: 'The run sandboxes could not be released.',
    });
  }
}

/** Revoke the run's gateway tokens; a failure goes to server diagnostics, never to the caller. */
export async function revokeRunTokensBestEffort(
  options: Pick<RunnerLauncherOptions, 'revokeRunTokens'>,
  context: LaunchContext,
): Promise<void> {
  try {
    await options.revokeRunTokens?.(context);
  } catch (cause) {
    publicRunFailure(cause, {
      operation: 'revoke-run-tokens',
      failureKind: 'upstream',
      publicMessage: 'The run tokens could not be revoked.',
    });
  }
}

/**
 * The secret values a preparation failure's log line is redacted of, or `null` when they are
 * unknown (no source, or it threw), so the line withholds the message. A coded refusal logs
 * nothing, so it reads none.
 */
export async function preparationSecretsOf(
  options: RunnerLauncherOptions,
  context: LaunchContext,
  cause: unknown,
): Promise<readonly string[] | null> {
  if (cause instanceof DomainError) return [];
  if (options.preparationSecrets === undefined) return null;
  return options.preparationSecrets(context).catch(() => null);
}

/**
 * Fail a launch whose request could not be prepared, with the public `detail`. An interrupt may
 * have ended the run while it was queued, after `buildRunRequest` minted its gateway token; then
 * `finish` is a no-op that revokes nothing, so the launch is abandoned like an interrupted one.
 */
export async function concludePreparationFailure(
  store: RunStore,
  options: RunnerLauncherOptions,
  context: LaunchContext,
  detail: string,
  startedAtMs: number,
  target: RuntimeLaunchTarget | undefined,
): Promise<void> {
  if (!(await store.markRunning(context.run.id))) {
    await abandonInterruptedLaunch(store, options, context, startedAtMs, target);
    return;
  }
  await store.appendPlatformEvent(context.run.id, {
    type: RUN_STATUS_EVENT,
    data: { status: 'running', error: null },
  });
  await conclude({
    store: store,
    context: context,
    status: 'failed',
    failureMessage: detail,
    startedAtMs: startedAtMs,
    options: options,
    target: target,
  });
}

/**
 * ADR-0146 Decision 3: compose removed the shell for the attachments' read grants. Said before
 * `/run` is posted, so the warning precedes the run's first agent frame.
 */
export async function warnAttachmentsRemovedShell(
  store: RunStore,
  context: LaunchContext,
): Promise<void> {
  if ((context.attachments?.length ?? 0) === 0) return;
  await store.appendPlatformEvent(context.run.id, {
    type: RUN_WARNING_EVENT,
    data: { code: 'attachments_removed_shell' },
  });
}

/**
 * Finalise a launch that must not reach the runtime, because the run went terminal while it was
 * still `queued` (issue #235, S-14).
 *
 * Revoking is what this path exists for: the interrupt's own `revokeForRun` ran before
 * {@link RunnerLauncherOptions.buildRunRequest} minted the run's gateway token, so without this
 * call the cancelled run leaves a live credential behind. A revocation that itself fails has
 * nowhere left to be written — the run is already terminal — so it goes to server diagnostics
 * rather than being lost, and finalisation still happens.
 */
export async function abandonInterruptedLaunch(
  store: RunStore,
  options: RunnerLauncherOptions,
  context: LaunchContext,
  startedAtMs: number,
  target: RuntimeLaunchTarget | undefined,
): Promise<void> {
  await revokeRunTokensBestEffort(options, context);
  // `finish` is first-call-wins, so the stored status and error stay the interrupt's; what this
  // adds is the terminal telemetry measurement every other outcome of a launch also emits.
  await conclude({
    store: store,
    context: context,
    status: 'cancelled',
    failureMessage: 'the run was interrupted before it reached the runtime',
    startedAtMs: startedAtMs,
    options: options,
    target: target,
  });
}

/**
 * Record the public `agent.approval.requested` frame, then pause the run on the call (ADR-0145).
 * A run whose frame cannot be saved fails instead, so a paused run always carries its request.
 */
async function pauseForApproval(
  store: RunStore,
  options: RunnerLauncherOptions,
  context: LaunchContext,
  outcome: Extract<RelayOutcome, { kind: 'awaiting_approval' }>,
  startedAtMs: number,
  target: RuntimeLaunchTarget | undefined,
): Promise<void> {
  const engine = EngineIdSchema.safeParse(context.run.engine);
  const appended = engine.success
    ? await store.append(context.run.id, {
        type: 'agent.approval.requested',
        data: {
          frame: 'agent.approval.requested',
          engine: engine.data,
          raw: null,
          toolCallId: outcome.toolCallId,
          toolName: outcome.call.toolName,
          canonicalCall: outcome.call.canonicalCall,
        },
      })
    : null;
  if (appended?.kind !== 'appended') {
    await conclude({
      store: store,
      context: context,
      status: 'failed',
      failureMessage: 'The approval request could not be saved.',
      startedAtMs: startedAtMs,
      options: options,
      target: target,
    });
    return;
  }
  await conclude({
    store: store,
    context: context,
    status: 'awaiting_approval',
    failureMessage: null,
    startedAtMs: startedAtMs,
    options: options,
    target: target,
    output: null,
    approval: outcome.call,
  });
}

/**
 * Maps how the relayed stream ended, plus any output-persistence failure, to the run's terminal
 * status and records it.
 */
async function concludeRelayed(
  store: RunStore,
  options: RunnerLauncherOptions,
  context: LaunchContext,
  outcome: RelayOutcome,
  persistenceFailure: string | null,
  startedAtMs: number,
  target: RuntimeLaunchTarget | undefined,
): Promise<void> {
  const publicOutcomeFailure =
    outcome.kind === 'completed' || outcome.kind === 'awaiting_approval'
      ? null
      : publicOutcomeMessage(options, context, outcome);
  if (outcome.kind === 'awaiting_approval' && persistenceFailure === null) {
    await pauseForApproval(store, options, context, outcome, startedAtMs, target);
  } else if (
    outcome.kind === 'completed' &&
    persistenceFailure === null &&
    context.outputSchema !== undefined &&
    (outcome.output?.structured ?? null) === null
  ) {
    // ADR-0143: a request that carried a schema is answered with a conforming `structured`
    // or fails; a completed run with none must not read as a success.
    await conclude({
      store: store,
      context: context,
      status: 'failed',
      failureMessage: `${OUTPUT_SCHEMA_UNSATISFIED}: ${OUTPUT_SCHEMA_UNSATISFIED_MESSAGE}`,
      startedAtMs: startedAtMs,
      options: options,
      target: target,
      output: null,
    });
  } else if (outcome.kind === 'completed' && persistenceFailure === null) {
    await conclude({
      store: store,
      context: context,
      status: 'completed',
      failureMessage: null,
      startedAtMs: startedAtMs,
      options: options,
      target: target,
      output: outcome.output,
    });
  } else if (outcome.kind === 'cancelled') {
    // Issue #235: the runner itself reported the interrupt — either this replica's own
    // `POST /api/runs/:id/interrupt` reached it, or an operator/credential-lifetime signal
    // did. `cancelled`, not `failed`: a user or the platform stopping a run on purpose is not
    // an error (`packages/core/src/db/schema/runs.ts`'s own comment on the status). `finish`
    // is first-call-wins, so this is a no-op when the interrupt route already concluded it.
    const reason =
      persistenceFailure === null
        ? publicOutcomeFailure
        : `${publicOutcomeFailure} ${persistenceFailure}`;
    await conclude({
      store: store,
      context: context,
      status: 'cancelled',
      failureMessage: reason,
      startedAtMs: startedAtMs,
      options: options,
      target: target,
    });
  } else {
    const reason =
      outcome.kind === 'completed' || outcome.kind === 'awaiting_approval'
        ? String(persistenceFailure)
        : persistenceFailure === null
          ? publicOutcomeFailure
          : `${publicOutcomeFailure} ${persistenceFailure}`;
    await conclude({
      store: store,
      context: context,
      status: 'failed',
      failureMessage: reason,
      startedAtMs: startedAtMs,
      options: options,
      target: target,
    });
  }
}

/**
 * Conclude a relayed run, once its watch has stopped: `cancelled` when the watch saw it stopped by
 * someone else while live (not a lifetime or relay failure), `failed` when its lifetime ran out,
 * and otherwise as the relay's outcome says.
 */
export async function concludeHeldRun(
  store: RunStore,
  options: RunnerLauncherOptions,
  context: LaunchContext,
  run: {
    readonly outcome: RelayOutcome;
    readonly persistenceFailure: string | null;
    readonly stoppedElsewhere: boolean;
    /** The lifetime's failure text when the lifetime expired, otherwise `null`. */
    readonly lifetimeFailure: string | null;
    readonly startedAtMs: number;
    readonly target: RuntimeLaunchTarget | undefined;
  },
): Promise<void> {
  const { persistenceFailure, startedAtMs, target } = run;
  if (run.stoppedElsewhere) {
    await conclude({
      store: store,
      context: context,
      status: 'cancelled',
      failureMessage: STOPPED_WHILE_LIVE,
      startedAtMs: startedAtMs,
      options: options,
      target: target,
    });
  } else if (run.lifetimeFailure !== null) {
    const reason = run.lifetimeFailure;
    const error = persistenceFailure === null ? reason : `${reason} ${persistenceFailure}`;
    await conclude({
      store: store,
      context: context,
      status: 'failed',
      failureMessage: error,
      startedAtMs: startedAtMs,
      options: options,
      target: target,
    });
  } else {
    await concludeRelayed(
      store,
      options,
      context,
      run.outcome,
      persistenceFailure,
      startedAtMs,
      target,
    );
  }
}
