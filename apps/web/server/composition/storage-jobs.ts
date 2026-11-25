/** The background job the storage composition starts: the cleanup pass. */
import { log } from '../telemetry/logger';
import { cronSecretFrom } from '../http/cron';
import type { ObjectStore } from '@agent-workspace/core/storage';
import { startStorageCleanup } from '../storage/cleanup-cron';
import type { CleanupMode } from '../storage/cleanup-cron';
import type { CleanupDependencies } from '../storage/cleanup';
import type { SessionStateBlobCatalog } from '../storage/service';
import type { createResourceCatalogStoreProvider } from '../storage/store';
import type { StorageCleanupWiring } from './storage';

/** The session-state blob rows of a workspace: the service reads them, the cleanup checks them. */
export type SessionStateOf = (
  workspaceId: string,
) => Promise<SessionStateBlobCatalog & Awaited<ReturnType<CleanupDependencies['sessionState']>>>;

export type StorageCleanupSetup = StorageCleanupWiring & { readonly mode: CleanupMode };

/**
 * Schedule the cleanup pass (the storage design, §04 "The cleanup job"): hourly in this process,
 * one pass at a time across servers.
 */
export async function startCleanupJob(
  objects: ObjectStore,
  catalog: ReturnType<typeof createResourceCatalogStoreProvider>,
  sessionState: SessionStateOf,
  cleanup: StorageCleanupSetup,
): Promise<void> {
  const { runCleanupPass } = await import('../storage/cleanup');
  const driver = startStorageCleanup({
    cronSecret: cronSecretFrom(process.env),
    stopOnClose: cleanup.stopOnClose,
    lock: cleanup.lock,
    log,
    pass: () =>
      runCleanupPass({
        objects,
        catalogs: (workspaceId) => catalog.forWorkspace(workspaceId),
        sessionState,
        workspaceIds: cleanup.workspaceIds,
        now: () => new Date(),
        mode: cleanup.mode,
        log,
      }),
  });
  log.info(
    driver === 'cron'
      ? `[compose] storage cleanup runs from GET /api/cron/storage-cleanup in ${cleanup.mode} mode (the storage design, §04).`
      : `[compose] storage cleanup scheduled hourly in ${cleanup.mode} mode (the storage design, §04).`,
  );
}
