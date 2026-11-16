import { dailyCostCapEnvironment } from '../../usage/daily-cost';
import type { RunApiWiring } from './run-api';
export function wireRunDailyCostCap({
  root,
  scopes,
  policyCeiling,
}: Pick<RunApiWiring, 'root' | 'scopes' | 'policyCeiling'>) {
  return dailyCostCapEnvironment(policyCeiling?.maxCostPerDayUsd, {
    now: () => new Date(),
    sumCostUsd: async (workspaceId, from, to) => {
      const scope = await scopes.forWorkspaceId(workspaceId);
      if (scope === null)
        throw new Error(`daily cost cap: workspace ${workspaceId} did not resolve`);
      return root.runs.forScope(scope).usageCostUsd(from, to);
    },
  });
}
