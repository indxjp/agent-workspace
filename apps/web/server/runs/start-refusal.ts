import { ProjectPolicyLimitsSchema } from '@indx-workspace/contracts/policy-ceiling';
import {
  RUN_APPROVAL_PROBLEM_CODES,
  RUN_START_PROBLEM_CODES,
} from '@indx-workspace/contracts/runs';
import { log } from '../telemetry/logger';
import type { DailyCostCap } from '../usage/daily-cost';
import type { RunLimitsOverride } from './environment';
import {
  ApprovalDecisionError,
  ChildRunLimitError,
  ParentRunStoppedError,
  SessionBusyError,
} from './store';

export interface RunStartRefused {
  readonly kind: 'refused';
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details?: readonly string[];
}

export const refused = (
  status: number,
  code: string,
  message: string,
  details?: readonly string[],
): RunStartRefused => ({
  kind: 'refused',
  status,
  code,
  message,
  ...(details === undefined ? {} : { details }),
});

export const structuredOutputUnsupported = (engine: string): RunStartRefused =>
  refused(
    422,
    'engine_capability_unsupported',
    `The engine '${engine}' does not support structuredOutput, so a run on it cannot take an outputSchema. Remove outputSchema or run an agent on an engine that supports it.`,
    ['structuredOutput'],
  );

export const dailyCostCapRefusal = async (
  cap: DailyCostCap | undefined,
  workspaceId: string,
): Promise<RunStartRefused | null> => {
  if (cap === undefined) return null;
  let reached: Awaited<ReturnType<DailyCostCap['refusal']>>;
  try {
    reached = await cap.refusal(workspaceId);
  } catch (error) {
    // Fail-closed: a spend that cannot be read is not under the cap. Only the error name is logged.
    log.error('[runs] the daily cost cap could not be checked', {
      error: error instanceof Error ? error.name : 'unknown',
    });
    return refused(
      RUN_START_PROBLEM_CODES.daily_cost_unavailable,
      'daily_cost_unavailable',
      'The workspace daily model cost could not be checked, so the run was not started. Try again shortly.',
    );
  }
  return reached === null
    ? null
    : refused(
        RUN_START_PROBLEM_CODES.daily_cost_cap_reached,
        'daily_cost_cap_reached',
        reached.unpricedUsage === true
          ? 'Some of the workspace model spend today has no price, so its daily cost cap cannot be measured; runs can start again after it resets.'
          : 'The workspace has reached its daily model cost cap; runs can start again after it resets.',
        [
          `capUsd: ${String(reached.capUsd)}`,
          `resetsAt: ${reached.resetsAt}`,
          ...(reached.unpricedUsage === true ? ['unpricedUsage: true'] : []),
        ],
      );
};

export const limitsRefusal = (limits: RunLimitsOverride | undefined): RunStartRefused | null =>
  limits === undefined || ProjectPolicyLimitsSchema.safeParse(limits).success
    ? null
    : refused(
        422,
        'invalid_run_limits',
        'A run limit must be a positive number (maxTurns a whole one).',
      );

export function createRefusal(error: unknown): RunStartRefused {
  if (error instanceof ApprovalDecisionError) {
    return error.reason === 'expired'
      ? refused(
          RUN_APPROVAL_PROBLEM_CODES.approval_expired,
          'approval_expired',
          `run ${error.runId} waited more than 24 hours for a decision; it was cancelled.`,
        )
      : refused(
          RUN_APPROVAL_PROBLEM_CODES.approval_already_decided,
          'approval_already_decided',
          `run ${error.runId} is no longer awaiting approval; it was already decided or stopped.`,
        );
  }
  if (error instanceof ChildRunLimitError) {
    return refused(
      409,
      'team_member_limit',
      `run ${error.runId} already has its most child runs; no member run was started.`,
    );
  }
  if (error instanceof ParentRunStoppedError) {
    return refused(
      409,
      'parent_run_stopped',
      `run ${error.runId} is no longer running; no member run was started.`,
    );
  }
  // Two runs resuming one engine session would interleave its transcript.
  if (!(error instanceof SessionBusyError)) throw error;
  return refused(
    409,
    'session_busy',
    'this session already has a run in progress; wait for it to finish or interrupt it.',
  );
}
