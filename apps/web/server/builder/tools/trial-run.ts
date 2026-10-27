import { BUILDER_REFUSAL_CODES } from '@indx-workspace/contracts/builder';

import type { Executor } from './types';

/** The only runner codes that become Builder refusals; the runner may never name any other. */
const TRIAL_REFUSAL_CODES = [
  'invalid_trial_input',
  'trial_not_stopped',
  'invalid_run_limits',
] as const;

const isTrialRefusalCode = (code: string): code is (typeof TRIAL_REFUSAL_CODES)[number] =>
  TRIAL_REFUSAL_CODES.some((known) => known === code);

/**
 * Runs the pinned version once, as the caller, under the trial budget. The approval, its single use
 * and the journal are the shell's. The run's answer is untrusted data: it goes into `output` and
 * nowhere else, and nothing here logs it.
 */
export const trialRun: Executor<'trial_run'> = async (call, ctx, ports) => {
  const { agentId, version, input } = call.input;
  const { trialBudgetUsd } = await ports.policy.limits(ctx);
  const result = await ports.runner.trial(
    ctx,
    agentId,
    version,
    input,
    trialBudgetUsd,
    `${ctx.runId}:${call.callId}`,
  );
  if (!result.ok) {
    const { code, message } = result;
    // Any other runner code, such as the run route's own, is one generic refusal: it never reaches
    // the model as a Builder code like `approval_required`.
    return isTrialRefusalCode(code)
      ? { ok: false, code, message, fix: BUILDER_REFUSAL_CODES[code].fix }
      : { ok: false, code: 'trial_refused', message };
  }
  const { runId, status, output, costUsd, truncated } = result;
  return {
    ok: true,
    runId,
    status,
    output,
    costUsd,
    awCommand: `aw runs get ${runId}`,
    ...(truncated ? { truncated: true as const } : {}),
  };
};
