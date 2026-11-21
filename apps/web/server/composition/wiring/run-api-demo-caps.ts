import { storageAreas } from '@agent-workspace/core/storage';
import type { Logger } from '@agent-workspace/core/telemetry';

import { clientBucket } from '../../http/rate-limit';
import { installedClientIdentity } from '../../client-identity';
import { systemClock } from '../../clock';
import { createLeadStore } from '../../demo/adapters/leads/store';
import { createDemoRunAdmissions } from '../../demo/caps/adapters/admissions/store';
import { createDemoSpend } from '../../demo/caps/adapters/spend/store';
import { createDemoRunGate } from '../../demo/caps/transport/gate';
import { createDemoApprovedWrites } from '../../demo/records/approved-writes';
import {
  createDemoWorkspaceFiles,
  type DemoStorage,
} from '../../demo/sweep/adapters/files/storage';
import { discardWorkspaceObjects } from '../../demo/sweep/adapters/files/objects';
import { createDemoSweepStore } from '../../demo/sweep/adapters/store/store';
import type { DemoWorkspaceFiles } from '../../demo/sweep/ports';
import { createDemoSweep } from '../../demo/sweep/transport/sweep';
import type { WorkspaceObjectStoreProvider } from '../../files/store';
import type { RunApiWiring } from './run-api';

/**
 * The Agent Store demo's records stand-ins for the run API (`RunApiEnvironment.demoApprovedWrites`,
 * ADR-0169): an approved write to one is kept in a visitor's own demo workspace (one with a demo
 * end, `workspaces.demo_expires_at`) and in the verification workspace
 * (`workspaces.demo_verification_at`). None where the
 * deployment serves no connectors, since there is then no stand-in to keep it in.
 */
export function wireRunDemoApprovedWrites({
  root,
  connectors,
}: Pick<RunApiWiring, 'root' | 'connectors'>) {
  return connectors.kind === 'serving'
    ? {
        demoApprovedWrites: createDemoApprovedWrites({
          connectors: connectors.runtime.connectors,
          keepsDemoWrites: (workspaceId) => root.demoCaps.keepsDemoWrites(workspaceId),
        }),
      }
    : {};
}

/**
 * The Agent Store demo's run caps for the run API (`RunApiEnvironment.demoRunGate`): the gate over
 * the database's admissions and spend, with the caps the deployment's settings name. The client a
 * start came from is keyed the way every other per-client limit keys it (`clientBucket`), read
 * from the identity the composition root installed.
 */
export function wireRunDemoCaps({ root, demo }: Pick<RunApiWiring, 'root' | 'demo'>) {
  return {
    demoRunGate: createDemoRunGate({
      settings: demo,
      admissions: createDemoRunAdmissions(root.demoCaps),
      spend: createDemoSpend(root.demoCaps),
      demoExpiresAt: (workspaceId) => root.demoCaps.demoExpiresAt(workspaceId),
      clientOf: (headers, limit) =>
        clientBucket(limit, headers ?? new Headers(), installedClientIdentity()),
      clock: systemClock,
    }),
  };
}

/** Where a demo workspace's files go when the deployment has no file storage: nothing to remove. */
const NO_FILES: DemoWorkspaceFiles = { removeAll: () => Promise.resolve() };

/**
 * The files of a demo workspace: the catalog's own through the storage service, then whatever
 * object that leaves, which the catalog never lists (a session-state blob, a pending upload, a row
 * already `deleting`; `demo/sweep/adapters/files/objects.ts`), so no object outlives the workspace.
 */
function workspaceFilesOf(
  storage: DemoStorage | undefined,
  objects: WorkspaceObjectStoreProvider | undefined,
): DemoWorkspaceFiles {
  const catalogFiles =
    storage === undefined ? NO_FILES : createDemoWorkspaceFiles(storage, storageAreas);
  if (objects === undefined) return catalogFiles;
  return {
    async removeAll(workspaceId) {
      await catalogFiles.removeAll(workspaceId);
      await discardWorkspaceObjects(objects.forWorkspace(workspaceId));
    },
  };
}

/**
 * The Agent Store demo sweeps (`demo/sweep`) for the trigger driver: expired demo workspaces
 * (their files through the storage service, every other object they hold, then their rows), spent login links, old admissions
 * and, once `AW_STORE_LEAD_RETENTION_DAYS` is set, old leads. The trigger cron route and the timer
 * call the one function this returns, so they share its throttle.
 */
export function wireDemoSweep(
  wired: Pick<RunApiWiring, 'root' | 'demo'> & {
    readonly filesRuntime: {
      readonly storage?: DemoStorage;
      readonly store?: WorkspaceObjectStoreProvider;
    } | null;
  },
  log: Pick<Logger, 'error' | 'info' | 'warn'>,
) {
  return createDemoSweep({
    store: createDemoSweepStore(wired.root.demoSweep),
    leads: createLeadStore(wired.root.storeLeads),
    files: workspaceFilesOf(wired.filesRuntime?.storage, wired.filesRuntime?.store),
    leadRetentionDays: wired.demo.leadRetentionDays,
    tryAcquireMaintenanceLease: (name, ttlMs) => wired.root.tryAcquireMaintenanceLease(name, ttlMs),
    clock: systemClock,
    log,
  });
}
