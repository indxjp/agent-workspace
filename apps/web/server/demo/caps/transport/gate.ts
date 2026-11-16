import { createDailyCostRule } from '@agent-workspace/core/daily-cost';
import type { DemoRunStartProblemCode } from '@indx-workspace/contracts/demo';

import type { Clock } from '../../../clock';
import type { DemoRunAdmissions, DemoSpend } from '../ports';
import {
  admissionRefusal,
  admissionWindowStart,
  capsUnconfigured,
  type DemoCapSettings,
} from '../core/rules';

const SITE_KEY = 'demo-site';

/** What one run start asks the gate about. */
export interface DemoRunStart {
  readonly workspaceId: string;
  readonly userId: string | null;
  readonly clientHeaders: Headers | null;
  /** `false` for an approval's continuation or a team child run: the site cost applies, the run counts do not. */
  readonly newRun: boolean;
}

export interface DemoRunGateDependencies {
  readonly settings: DemoCapSettings;
  readonly admissions: DemoRunAdmissions;
  readonly spend: DemoSpend;
  /** When the workspace's demo ends; `null` for a workspace that is not a demo workspace. */
  readonly demoExpiresAt: (workspaceId: string) => Promise<Date | null>;
  /** The client the headers identify, as `http/rate-limit.ts`'s `clientBucket` keys it. */
  readonly clientOf: (
    headers: Headers | null,
    limit: number,
  ) => { readonly key: string; readonly limit: number };
  readonly clock: Clock;
  /** How long the site's spend read is reused; the shared daily cost rule's 60 s unless a test says otherwise. */
  readonly siteSpendTtlMs?: number;
}

/**
 * The demo run-start gate the run API reads (`runs/demo-run-gate.ts`): `null` for a start in any
 * workspace that is not a demo workspace, otherwise the first check that refuses it: a demo that
 * has ended (`demo_expired`: its end is now or past, the sweep's own boundary, whether or not the
 * sweep has deleted it yet), then the caps in the order the spec states: an unset cap
 * (`demo_caps_unconfigured`), the site's cost today
 * (`demo_site_cost_reached`), then the person's and the client's runs (`demo_person_runs_reached`,
 * `demo_client_runs_reached`), the last of which records the admission. A start that is not a new run
 * (`newRun` false: an approval's continuation, a team child run) meets the end and cost checks only. A start with no person
 * is counted against no one, so it is refused as the person's cap.
 */
export function createDemoRunGate(deps: DemoRunGateDependencies): {
  readonly refusal: (
    start: DemoRunStart,
  ) => Promise<{ readonly code: DemoRunStartProblemCode } | null>;
} {
  const { settings, clock } = deps;
  // The shared daily cost rule (`@agent-workspace/core/daily-cost`): fail-closed on an unreadable or
  // non-numeric sum, unpriced usage refuses, and the read is cached so a start does not query the
  // whole site's spend each time. The site is one "workspace" key; the read ignores it.
  const siteCost = createDailyCostRule({
    now: () => clock.now(),
    ...(deps.siteSpendTtlMs === undefined ? {} : { ttlMs: deps.siteSpendTtlMs }),
    sumCostUsd: async (_site, from) => {
      const spent = await deps.spend.spentOn(from);
      return { costUsd: String(spent.costUsd), unpricedUsage: spent.unpricedUsage };
    },
  });
  return {
    async refusal({ workspaceId, userId, clientHeaders, newRun }) {
      const expiresAt = await deps.demoExpiresAt(workspaceId);
      if (expiresAt === null) return null;
      const now = clock.now();
      // The demo has ended; the sweep deletes the workspace soon, but it must not run until then.
      if (expiresAt.getTime() <= now.getTime()) return { code: 'demo_expired' };
      if (capsUnconfigured(settings)) return { code: 'demo_caps_unconfigured' };
      const siteCap = settings.siteMaxCostPerDayUsd;
      if (siteCap !== null) {
        if ((await siteCost.refusal(SITE_KEY, siteCap)) !== null) {
          return { code: 'demo_site_cost_reached' };
        }
      }
      if (!newRun) return null;
      if (userId === null) return { code: 'demo_person_runs_reached' };
      const client = deps.clientOf(clientHeaders, settings.runsPerClientPerDay);
      const admission = await deps.admissions.admit({
        userId,
        clientKey: client.key,
        now,
        since: admissionWindowStart(now),
        personLimit: settings.runsPerPersonPerDay,
        clientLimit: client.limit,
      });
      return admission.kind === 'admitted' ? null : { code: admissionRefusal(admission) };
    },
  };
}
