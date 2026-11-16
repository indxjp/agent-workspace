import type { Logger } from '@agent-workspace/core/telemetry';

import type { Clock } from '../../../clock';
import type { LeadStore } from '../../ports';
import {
  admissionCutoff,
  DEMO_SWEEP_LEASE_NAME,
  DEMO_SWEEP_LEASE_TTL_MS,
  DEMO_SWEEP_MIN_INTERVAL_MS,
  DEMO_SWEEP_WORKSPACES_PER_PASS,
  leadCutoff,
  loginTokenCutoff,
} from '../core/rules';
import type { DemoSweepStore, DemoWorkspaceFiles } from '../ports';

export interface DemoSweepDependencies {
  readonly store: DemoSweepStore;
  readonly leads: LeadStore;
  readonly files: DemoWorkspaceFiles;
  /** `AW_STORE_LEAD_RETENTION_DAYS`; `null` while unset, and then no lead is deleted. */
  readonly leadRetentionDays: number | null;
  readonly tryAcquireMaintenanceLease: (
    name: string,
    ttlMs: number,
  ) => Promise<null | { release(): Promise<void> }>;
  readonly clock: Clock;
  readonly log: Pick<Logger, 'error' | 'info' | 'warn'>;
}

export interface DemoSweepResult {
  readonly leaseHeld: boolean;
  /** The sweep ran less than {@link DEMO_SWEEP_MIN_INTERVAL_MS} ago in this process. */
  readonly throttled: boolean;
  readonly workspacesDeleted: number;
  /** Workspaces whose deletion threw; the next sweep tries again. */
  readonly workspacesFailed: number;
  readonly loginTokensDeleted: number;
  readonly admissionsDeleted: number;
  /** Guest users nothing holds any more (no workspace, no admission): their email goes with them. */
  readonly guestUsersDeleted: number;
  /** Leads deleted; `null` when the retention period is unset and the job did not run. */
  readonly leadsDeleted: number | null;
}

const NOTHING: DemoSweepResult = {
  leaseHeld: false,
  throttled: false,
  workspacesDeleted: 0,
  workspacesFailed: 0,
  loginTokensDeleted: 0,
  admissionsDeleted: 0,
  guestUsersDeleted: 0,
  leadsDeleted: null,
};

/**
 * The demo sweeps as one job (internal spec, "Email-link sign-in" and "Privacy notice and lead
 * retention"): delete each demo workspace once its end has passed (its files first, then its rows,
 * with its spend carried into the day's total), delete spent and expired login links, prune old
 * admissions, delete the guest users nothing holds any more (their email address), and delete leads past the retention period. Call it as often as you like: it runs
 * at most once per {@link DEMO_SWEEP_MIN_INTERVAL_MS} in this process, and under the maintenance
 * lease, so replicas never sweep together. A step that throws is logged and does not stop the
 * others; the next sweep tries it again.
 */
export function createDemoSweep(deps: DemoSweepDependencies): () => Promise<DemoSweepResult> {
  let lastSweptAt: Date | null = null;
  const unsetLogged = { done: false };
  return async () => {
    const now = deps.clock.now();
    if (
      lastSweptAt !== null &&
      now.getTime() - lastSweptAt.getTime() < DEMO_SWEEP_MIN_INTERVAL_MS
    ) {
      return { ...NOTHING, throttled: true };
    }
    const held = await deps.tryAcquireMaintenanceLease(
      DEMO_SWEEP_LEASE_NAME,
      DEMO_SWEEP_LEASE_TTL_MS,
    );
    if (held === null) return { ...NOTHING, leaseHeld: true };
    lastSweptAt = now;
    try {
      const workspaces = await sweepWorkspaces(deps, now);
      return {
        ...NOTHING,
        ...workspaces,
        loginTokensDeleted: await step(deps, 'login tokens', () =>
          deps.store.deleteLoginTokensBefore(loginTokenCutoff(now)),
        ),
        admissionsDeleted: await step(deps, 'admissions', () =>
          deps.store.deleteAdmissionsBefore(admissionCutoff(now)),
        ),
        guestUsersDeleted: await step(deps, 'guest users', () =>
          deps.store.deleteIdleGuestUsersBefore(admissionCutoff(now)),
        ),
        leadsDeleted: await sweepLeads(deps, now, unsetLogged),
      };
    } finally {
      await held.release();
    }
  };
}

/** Run one step; a throw is logged by name and counts as nothing deleted. */
async function step(
  deps: DemoSweepDependencies,
  name: string,
  run: () => Promise<number>,
): Promise<number> {
  try {
    return await run();
  } catch (error) {
    deps.log.error(`[demo-sweep] ${name} failed`, { error });
    return 0;
  }
}

async function sweepWorkspaces(
  deps: DemoSweepDependencies,
  now: Date,
): Promise<Pick<DemoSweepResult, 'workspacesDeleted' | 'workspacesFailed'>> {
  let ids: readonly string[];
  try {
    ids = await deps.store.expiredWorkspaceIds(now, DEMO_SWEEP_WORKSPACES_PER_PASS);
  } catch (error) {
    deps.log.error('[demo-sweep] could not list the expired demo workspaces', { error });
    return { workspacesDeleted: 0, workspacesFailed: 0 };
  }
  let workspacesDeleted = 0;
  let workspacesFailed = 0;
  for (const workspaceId of ids) {
    try {
      // The bytes go before the rows: a workspace whose files cannot be removed is kept, whole, for
      // the next sweep, so no object is left with no row to find it by.
      await deps.files.removeAll(workspaceId);
      if (await deps.store.deleteExpiredWorkspace(workspaceId, now)) workspacesDeleted += 1;
    } catch (error) {
      workspacesFailed += 1;
      deps.log.error(`[demo-sweep] demo workspace ${workspaceId} failed`, { error });
    }
  }
  return { workspacesDeleted, workspacesFailed };
}

async function sweepLeads(
  deps: DemoSweepDependencies,
  now: Date,
  unsetLogged: { done: boolean },
): Promise<number | null> {
  if (deps.leadRetentionDays === null) {
    // Once per process: the sweep runs every few minutes and the setting does not change under it.
    if (!unsetLogged.done) {
      deps.log.info('[demo-sweep] AW_STORE_LEAD_RETENTION_DAYS is unset; no lead is deleted');
      unsetLogged.done = true;
    }
    return null;
  }
  const retentionDays = deps.leadRetentionDays;
  return step(deps, 'leads', () =>
    deps.leads.deleteLastContactBefore(leadCutoff(now, retentionDays)),
  );
}
