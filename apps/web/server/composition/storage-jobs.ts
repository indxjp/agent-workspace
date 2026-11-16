/** The background jobs the storage composition starts: the cleanup pass and the skills adopt pass. */
import { log } from '../telemetry/logger';
import { cronSecretFrom } from '../http/cron';
import type { ObjectStore } from '@agent-workspace/core/storage';
import { startStorageCleanup } from '../storage/cleanup-cron';
import type { CleanupMode } from '../storage/cleanup-cron';
import type { CleanupDependencies } from '../storage/cleanup';
import type { SessionStateBlobCatalog, StorageService } from '../storage/service';
import type {
  createResourceCatalogStoreProvider,
  WorkspaceSkillsStoreProvider,
} from '../storage/store';
import { configuredPath } from './config';
import { safeProviderErrorName } from './storage-open';
import type { SkillsAdoptWiring, StorageCleanupWiring } from './storage';

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

const STORAGE_MIGRATE_ENV = 'AW_STORAGE_MIGRATE';

/**
 * The skills adopt pass (the storage design, §06), in the background and under its own database
 * lock. Off with `AW_STORAGE_MIGRATE=off`; this release has no other stage, so any other value runs
 * it, unless the latest recorded pass already proved no old skill form is left. Never rejects; a
 * failure is logged by name.
 */
// storage-bridge(#1699): old skill forms
export async function startSkillsAdopt(
  store: WorkspaceSkillsStoreProvider,
  catalog: ReturnType<typeof createResourceCatalogStoreProvider>,
  storage: StorageService,
  adopt: SkillsAdoptWiring,
): Promise<void> {
  if (configuredPath(STORAGE_MIGRATE_ENV) === 'off') return;
  try {
    const { runSkillsAdoptStage, skillsAdoptProven } = await import('../storage/migrate-skills');
    const ran = await adopt.lock('storage-migrate-skills', async () => {
      // Read under the lock, so a pass another server just finished counts.
      if (skillsAdoptProven(await adopt.migrationRuns.latest('skills'))) return 'proven';
      await runSkillsAdoptStage({
        workspaceIds: adopt.workspaceIds,
        objects: (workspaceId) => store.forWorkspace(workspaceId),
        catalog: (workspaceId) => Promise.resolve(catalog.forWorkspace(workspaceId)),
        ownerPrincipalId: (workspaceId) => adopt.owners.ownerPrincipalId(workspaceId),
        storage,
        runs: adopt.migrationRuns,
        log,
      });
      return 'ran';
    });
    if (!ran.acquired) log.info('skills adopt skipped: another server is running it');
    else if (ran.value === 'proven') {
      log.info('skills adopt skipped: the latest pass left no old skill forms');
    }
  } catch (error) {
    log.error(`[compose] skills adopt stopped (name=${safeProviderErrorName(error)}).`);
  }
}
