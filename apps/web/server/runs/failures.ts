import { log as webLog } from '../telemetry/logger';
import { RUN_PREPARATION_FAILED } from '@indx-workspace/contracts/runs';

import { RuntimeManagerError } from '../compose/runtime-manager-client';
import { DomainError, InfrastructureError, toInfrastructureError } from '../errors';
import { redacted } from '@agent-workspace/core/telemetry';

export interface RunFailureContext {
  readonly operation: string;
  readonly publicMessage: string;
  readonly failureKind?: InfrastructureError['failureKind'];
  readonly log?: (message: string, error: InfrastructureError) => void;
}

/**
 * Keep an execution failure's cause in server diagnostics while returning only deliberately
 * public text to the durable run record or SSE client.
 */
export function publicRunFailure(cause: unknown, context: RunFailureContext): string {
  const failure = toInfrastructureError(cause, {
    component: 'runs',
    operation: context.operation,
    ...(context.failureKind === undefined ? {} : { failureKind: context.failureKind }),
  });
  if (failure instanceof DomainError) return failure.publicMessage;

  const log =
    context.log ??
    ((message: string, error: InfrastructureError) => webLog.error(message, { error }));
  log(`[runs] ${context.operation} failed`, failure);
  return context.publicMessage;
}

/** The part of preparing a run request that threw; a closed set, so it is safe in public text. */
export type PreparationStep =
  | 'runtime_profile'
  | 'runtime_connection'
  | 'tools'
  | 'secrets'
  | 'allocation'
  | 'model'
  | 'resources'
  | 'transcription'
  | 'token'
  | 'compose'
  | 'prepare';

/** An uncoded failure tagged with the step that threw it; `cause` stays in server diagnostics. */
export class PreparationStepError extends Error {
  override readonly name = 'PreparationStepError';

  constructor(
    readonly step: PreparationStep,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : `the ${step} step failed`, { cause });
  }
}

/**
 * Runs `work` and tags an uncoded failure with `step`. A coded refusal keeps its own code, and the
 * innermost step wins, so a caller can wrap a whole phase and still name the sub-step that threw.
 */
export async function atStep<T>(step: PreparationStep, work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof DomainError || cause instanceof PreparationStepError) throw cause;
    throw new PreparationStepError(step, cause);
  }
}

/**
 * The values among `resolutions` that resolved to a secret. A secret this process could not
 * decrypt cannot appear in its own error text, so it is dropped rather than failing the whole
 * lookup and withholding the log line of every preparation failure.
 */
export async function resolvedSecretValues(
  resolutions: readonly Promise<string | null>[],
): Promise<string[]> {
  const settled = await Promise.allSettled(resolutions);
  return settled.flatMap((outcome) =>
    outcome.status === 'fulfilled' && outcome.value !== null ? [outcome.value] : [],
  );
}

const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;
/** Room for a runner-manager message that wraps a provider reason of up to 160 characters. */
const MAX_MANAGER_DETAIL = 400;

/**
 * The stored `error` of a run whose request could not be prepared (issue #827). The cause goes to
 * the server log by name with its message redacted of `secrets` (the run's known secret values);
 * with `secrets` unknown (`null`) the message is withheld. The public text carries only the step,
 * the error name and, for a runner-manager answer, its vetted `safeCause` (status and fixed tokens)
 * plus, for `tool_sandbox_unavailable`, the manager's message redacted of `secrets` like the log
 * line, so a failed run names the throw site.
 */
export function publicPreparationFailure(
  cause: unknown,
  secrets: readonly string[] | null,
  log: (message: string) => void = (message) => webLog.error(message),
): string {
  if (cause instanceof DomainError) return cause.publicMessage;
  const step = cause instanceof PreparationStepError ? cause.step : 'prepare';
  const root = cause instanceof PreparationStepError ? cause.cause : cause;
  const rawName = root instanceof Error ? root.name : 'non-error thrown';
  const name = SAFE_ERROR_NAME.test(rawName) ? rawName : 'Error';
  const message = !(root instanceof Error)
    ? ''
    : secrets === null
      ? '[withheld]'
      : redacted(root.message, secrets);
  log(`[runs] run preparation failed at the ${step} step (${rawName}): ${message}`);
  const safeCause = root instanceof RuntimeManagerError ? `: ${root.safeCause}` : '';
  const detail =
    root instanceof RuntimeManagerError && root.detail !== undefined && secrets !== null
      ? `: ${redacted(root.detail.replace(/\s+/gu, ' ').trim(), secrets, MAX_MANAGER_DETAIL)}`
      : '';
  return `${RUN_PREPARATION_FAILED}: The run request could not be prepared at the ${step} step (${name}${safeCause}${detail}).`;
}
