import { createModelJudge } from '../../evaluations/handlers';
import type { RunEvaluationEnvironment } from '../../runs/environment';
import { scriptedModelsOption } from '../config';
import type { RunApiWiring } from './run-api';
export function wireRunEvaluations(
  wired: Pick<
    RunApiWiring,
    'root' | 'scopes' | 'modelsApi' | 'readRunAgent' | 'runs' | 'runPreflight' | 'evaluationsOf'
  >,
): RunEvaluationEnvironment {
  const { root, scopes, modelsApi, readRunAgent, runPreflight, evaluationsOf } = wired;
  return {
    // Issue #618: one row per evaluation; the handler has already authorised it and run its cases.
    recordEvaluation: async (principal, evaluation) => {
      const scope = await scopes.forWorkspaceId(principal.workspaceId);
      if (scope === null) {
        throw new Error(`evaluation: workspace ${principal.workspaceId} did not resolve`);
      }
      return root.agentVersionEvaluations.forScope(scope).record({
        ...evaluation,
        createdByPrincipalId: principal.principalId,
      });
    },

    // Issue #799: an evaluation run's rows; every call opens this workspace's repository.
    evaluationRuns: {
      start: async (principal, run) =>
        (await evaluationsOf(principal.workspaceId)).start({
          ...run,
          createdByPrincipalId: principal.principalId,
        }),
      find: async (principal, id) => (await evaluationsOf(principal.workspaceId)).find(id),
      claim: async (principal, id, leaseMs) =>
        (await evaluationsOf(principal.workspaceId)).claim(id, leaseMs),
      progress: async (principal, id, progress) =>
        (await evaluationsOf(principal.workspaceId)).progress(id, progress),
    },

    judgeEvaluationCase: createModelJudge({
      // Judged by version n's model connection, like its runs, not by `local`'s row.
      resolveModel: async ({ agentVersionId, ...query }) =>
        runPreflight.resolveModel({
          ...query,
          agent: (await readRunAgent(query.workspaceId, query.agentId, agentVersionId)).agent,
        }),
      connection: async (workspaceId, connectionId) =>
        (await modelsApi?.models.forWorkspace(workspaceId)?.resolve(connectionId)) ?? null,
      ...scriptedModelsOption(process.env),
    }),
  };
}
