import { RUN_START_PROBLEM_CODES } from '@indx-workspace/contracts/runs';
import type { Usd } from '../newtypes';
import { effectiveSpendCeiling, SPEND_CEILING_WIDENS_MESSAGE } from './spend-ceiling';
import type { RunStartContext } from './start-input';
import { dailyCostCapRefusal, limitsRefusal, refused, type RunStartRefused } from './start-refusal';
import { isAudioAttachment } from './transcription';

type RunPreparation =
  RunStartRefused | { readonly kind: 'ready'; readonly spendCeilingUsd: Usd | null };

async function checkSpendCeiling(
  { env, principal, agent, input }: RunStartContext,
  sessionId: string | null,
): Promise<RunPreparation> {
  const limit =
    env.spendLimitFor === undefined
      ? null
      : await env.spendLimitFor(
          principal,
          agent,
          sessionId,
          sessionId === null ? input.agentVersionId : undefined,
        );
  const decision = effectiveSpendCeiling(limit, input.limits?.maxBudgetUsd, input.spendCeilingUsd);
  if (decision.kind === 'widens') {
    return refused(
      RUN_START_PROBLEM_CODES.policy_cannot_widen,
      'policy_cannot_widen',
      SPEND_CEILING_WIDENS_MESSAGE,
      ['spendCeilingUsd'],
    );
  }
  return { kind: 'ready', spendCeilingUsd: decision.spendCeilingUsd };
}

export async function prepareRunStart(
  context: RunStartContext,
  sessionId: string | null,
): Promise<RunPreparation> {
  const { env, principal, agent, input } = context;
  const attachments = input.attachments ?? [];
  if (agent.archived === true) {
    return refused(
      RUN_START_PROBLEM_CODES.agent_archived,
      'agent_archived',
      'This agent is archived and starts no run; restore it to run it again.',
    );
  }
  const capReached = await dailyCostCapRefusal(env.dailyCostCap, principal.workspaceId);
  if (capReached !== null) return capReached;
  const badLimits = limitsRefusal(input.limits);
  if (badLimits !== null) return badLimits;
  const refusal =
    env.preflight === undefined
      ? null
      : await env.preflight(
          principal,
          agent,
          sessionId,
          input.modelOverride,
          sessionId === null ? input.agentVersionId : undefined,
          attachments.length,
          attachments.filter(isAudioAttachment).length,
          {
            attachments,
            ...(input.fileScope === undefined ? {} : { fileScope: input.fileScope }),
          },
        );
  return refusal === null
    ? checkSpendCeiling(context, sessionId)
    : refused(RUN_START_PROBLEM_CODES[refusal.code], refusal.code, refusal.message);
}
