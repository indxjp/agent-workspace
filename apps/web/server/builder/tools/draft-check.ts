import type { Executor } from './types';

/** A dry run of the pipeline; a failed check, `forbidden` included, is returned unchanged. */
export const draftCheck: Executor<'draft_check'> = async (call, ctx, ports) => {
  const { agentId, body } = call.input;
  const result = await ports.checker.check(ctx, agentId, body);
  if (!result.ok) return result;
  // Without --yes, `aw agents versions create` only checks; `aw check` checks a project's new agents.
  const awCommand =
    agentId === undefined ? 'aw check' : `aw agents versions create ${agentId} --file draft.json`;
  return { ok: true, valid: true, problems: [], awCommand };
};
