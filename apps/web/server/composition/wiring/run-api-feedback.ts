import type { RunFeedbackEnvironment } from '../../runs/environment';
import type { RunApiWiring } from './run-api';
export function wireRunFeedback(
  wired: Pick<RunApiWiring, 'root' | 'scopes' | 'agents'>,
): Pick<RunFeedbackEnvironment, 'recordRunFeedback' | 'listAgentFeedback'> {
  const { root, scopes, agents } = wired;
  return {
    // Issue #539 (S2-05c, C19): one row per rating; the handler has already authorised the call.
    recordRunFeedback: async (principal, run, { rating, comment }) => {
      const scope = await scopes.forWorkspaceId(principal.workspaceId);
      if (scope === null) {
        throw new Error(`run feedback: workspace ${principal.workspaceId} did not resolve`);
      }
      await root.runFeedback
        .forScope(scope)
        .record({ runId: run.id, rating, comment: comment ?? null });
    },

    // Issue #620: the handler has authorised the call and decided the owner filter.
    // ponytail: one event read per row (at most 50); store the answer on the run if it gets slow.
    listAgentFeedback: async (principal, { agentId, ...filter }) => {
      const scope = await scopes.forWorkspaceId(principal.workspaceId);
      if (scope === null) {
        throw new Error(`run feedback: workspace ${principal.workspaceId} did not resolve`);
      }
      if ((await agents.forWorkspace(principal.workspaceId).get(agentId)) === null) return null;
      const events = root.runEvents.forScope(scope);
      const rows = await root.runFeedback.forScope(scope).listForAgent({ agentId, ...filter });
      return Promise.all(
        rows.map(async ({ prompt, ...row }) => ({
          ...row,
          input: prompt,
          events: await events.list(row.runId, null),
        })),
      );
    },
  };
}
