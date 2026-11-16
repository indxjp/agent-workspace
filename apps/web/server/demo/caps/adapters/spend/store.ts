import type { DemoCapsRepository } from '@agent-workspace/core/db';

import { utcDayEnd } from '../../core/rules';
import type { DemoDaySpend, DemoSpend } from '../../ports';

/**
 * The production {@link DemoSpend}: the usage of the live demo workspaces on the UTC day plus
 * `demo_daily_costs` for the workspaces already deleted. A read that fails rejects, so the gate
 * refuses the start rather than admit one it could not price.
 */
export function createDemoSpend(repository: DemoCapsRepository): DemoSpend {
  return {
    async spentOn(dayStart): Promise<DemoDaySpend> {
      const spent = await repository.spentOn(dayStart, utcDayEnd(dayStart));
      return { costUsd: Number(spent.costUsd), unpricedUsage: spent.unpricedUsage };
    },
  };
}
