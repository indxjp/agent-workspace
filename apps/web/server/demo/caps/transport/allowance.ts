import type { DemoAllowance } from '@indx-workspace/contracts/demo';

import type { Clock } from '../../../clock';
import { admissionWindowStart } from '../core/rules';
import type { DemoRunAdmissions } from '../ports';

export interface DemoAllowanceDependencies {
  /** `AW_DEMO_RUNS_PER_PERSON_PER_DAY`. */
  readonly runsPerPersonPerDay: number;
  readonly admissions: Pick<DemoRunAdmissions, 'countSince'>;
  /** When the workspace's demo ends; `null` for a workspace that is not a demo workspace. */
  readonly demoExpiresAt: (workspaceId: string) => Promise<Date | null>;
  readonly clock: Clock;
}

/**
 * What a guest's demo has left (`GET /api/demo/allowance`): the person's runs in the same rolling
 * window and from the same table the run-start gate counts, so the number the store shows is the
 * number the gate enforces. `null` for a workspace that is not a demo workspace.
 */
export function createDemoAllowance(deps: DemoAllowanceDependencies): {
  readonly read: (workspaceId: string, userId: string) => Promise<DemoAllowance | null>;
} {
  return {
    async read(workspaceId, userId) {
      const expiresAt = await deps.demoExpiresAt(workspaceId);
      if (expiresAt === null) return null;
      const used = await deps.admissions.countSince(userId, admissionWindowStart(deps.clock.now()));
      return {
        runsPerDay: deps.runsPerPersonPerDay,
        runsLeft: Math.max(0, deps.runsPerPersonPerDay - used),
        expiresAt: expiresAt.toISOString(),
      };
    },
  };
}
