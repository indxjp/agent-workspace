import { BUILDER_REFUSAL_CODES } from '@indx-workspace/contracts/builder';

import { startOfUtcDay } from '../core/facts';
import { pointerMovedDetails } from '../core/rules';
import type { Executor } from './types';

/**
 * Checks and saves as the caller on `local` only. The store audits the save in its own transaction;
 * the ids it answers come from the store, never from the model's arguments.
 */
export const draftSave: Executor<'draft_save'> = async (call, ctx, ports, creator) => {
  const { agentId, baseVersion, body, summary } = call.input;
  const checked = await ports.checker.check(ctx, agentId, body);
  if (!checked.ok) return checked;
  const draft = { body, ...(summary === undefined ? {} : { summary }) };
  // A new agent made by an agent records which agent and version made it; the run is `ctx.runId`.
  const createdByAgent =
    creator.kind === 'agent' && ctx.door.kind === 'run'
      ? { agentId: ctx.door.agentId, version: ctx.door.agentVersion }
      : undefined;
  const saved = await ports.store.save(
    ctx,
    agentId === undefined
      ? {
          ...draft,
          // The day and limit the quota rule read, re-checked by the store inside the create transaction.
          quota: {
            since: startOfUtcDay(ports.clock()),
            limit: (await ports.policy.limits(ctx)).creationsPerWorkspacePerDay,
          },
          ...(createdByAgent === undefined ? {} : { createdByAgent }),
        }
      : { ...draft, agentId, baseVersion: baseVersion ?? null },
  );
  if (!saved.ok) {
    if (!('current' in saved)) return saved;
    const fix = BUILDER_REFUSAL_CODES.pointer_moved.fix;
    return {
      ok: false,
      code: saved.code,
      message: fix,
      details: pointerMovedDetails(saved.current),
      fix,
    };
  }
  return {
    ok: true,
    agentId: saved.agentId,
    version: saved.version,
    pointer: 'local',
    awCommand: `aw agents versions show ${saved.agentId} ${String(saved.version)}`,
  };
};
