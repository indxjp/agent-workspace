import { randomUUID } from 'node:crypto';
import { ORDER_STATUS_FRAMES } from '../../../evaluations/fixtures';
import type { LaunchContext, RunApiEnvironment, RunPrincipal } from '../../../runs/environment';
import type { RunStore } from '../../../runs/store';
import { WORKSPACE, MEMBERS, type BuilderDoorOptions } from './harness-contract.test-support';

export function createHarnessRunApi(options: BuilderDoorOptions) {
  const { runStore } = options;
  const launched: LaunchContext[] = [];
  const person: RunPrincipal = {
    principalId: MEMBERS.builder,
    ownerPrincipalId: MEMBERS.builder,
    userId: 'user-builder',
    workspaceId: WORKSPACE,
    role: 'owner',
    scope: null,
  };
  // A run with a limit (a trial, an evaluation case) answers the order-status frames and ends; any other stays queued.
  const runApiOver = (store: RunStore): RunApiEnvironment => ({
    authenticate: (request) =>
      Promise.resolve(request.headers.get('x-test-user') === null ? null : person),
    findAgent: (_principal, id) =>
      Promise.resolve({ id, workspaceId: WORKSPACE, engine: 'claude-agent-sdk' }),
    openSession: (_principal, agent, requested, agentVersionId) =>
      Promise.resolve({
        id: requested ?? randomUUID(),
        agentId: agent.id,
        engine: null,
        agentVersionId: agentVersionId ?? null,
      }),
    ownsRun: () => Promise.resolve(true),
    store,
    interruptRun: async (_principal, run) => store.finish(run.id, 'cancelled', null),
    launch(context) {
      launched.push(context);
      if (context.limits === undefined) return;
      void (async () => {
        for (const frame of ORDER_STATUS_FRAMES) {
          await store.append(context.run.id, { type: frame.frame, data: frame });
        }
        await store.finish(context.run.id, 'completed', null, true, {
          text: 'Order 1042 has shipped.',
          structured: null,
        });
      })();
    },
    recordEvaluation: () => Promise.resolve({ id: randomUUID(), createdAt: new Date() }),
  });
  const baseRunApi = runStore === undefined ? null : runApiOver(runStore);
  const requireRunApi = (): RunApiEnvironment => {
    if (baseRunApi === null) throw new Error('This door was built without a runStore.');
    return baseRunApi;
  };
  const runApi =
    baseRunApi === null || options.wrapRunApi === undefined
      ? baseRunApi
      : options.wrapRunApi(baseRunApi);

  return { runStore, launched, person, requireRunApi, runApi };
}
