import { SIGNED_UPLOAD_HARD_MAX_BYTES } from '@indx-workspace/contracts/files';
import { log } from '../telemetry/logger';
import type { DatabaseRoot } from '@agent-workspace/core/db';
import type { WorkspaceResolution } from '../agents/runtime';
import type { Files } from '../files/runtime';
import { readStorageCleanupMode, STORAGE_CLEANUP_ENV } from '../storage/cleanup-cron';
import type { StorageService } from '../storage/service';
import type { createResourceCatalogStoreProvider, MigrationRuns } from '../storage/store';
import { configuredPath } from './config';
import { startCleanupJob, type SessionStateOf, type StorageCleanupSetup } from './storage-jobs';
import {
  describePlace,
  logAreaNotOpened,
  openArea,
  openOptionsFor,
  readCreateBucket,
  safeProviderErrorName,
  storageReadinessFailure,
  type AreaSelection,
} from './storage-open';

export { storageReadinessFailure };
export { installSkillsApi } from './storage-skills';

/** What the cleanup job needs from the database root, and the mode read once at start-up. */
export interface StorageCleanupWiring {
  readonly lock: DatabaseRoot['withNamedLock'];
  readonly workspaceIds: DatabaseRoot['listWorkspaceIds'];
  /** The audit trail's sink; the storage service records file actions through it. */
  readonly audit?: DatabaseRoot['recordAuditEvent'];
  readonly stopOnClose: (stop: () => void) => void;
}

/** What the skills adopt pass needs from the database root. */
export interface SkillsAdoptWiring extends Pick<StorageCleanupWiring, 'lock' | 'workspaceIds'> {
  readonly migrationRuns: MigrationRuns;
  readonly owners: Pick<DatabaseRoot['workspaces'], 'ownerPrincipalId'>;
}

/** What both storage-backed APIs are built over: who the caller's workspace is, and its catalog. */
export type ApiWiring = Readonly<{
  resolveWorkspace: (request: Request) => Promise<WorkspaceResolution>;
  scopes: DatabaseRoot['scopes'];
  catalog: ReturnType<typeof createResourceCatalogStoreProvider>;
}>;

type OpenedArea = Extract<AreaSelection, { kind: 'opened' }>;
type ResourceCatalog = ReturnType<typeof createResourceCatalogStoreProvider>;

/**
 * The catalog service over the `AW_STORAGE_URL` root. `null` when there is no shared root or it
 * cannot be opened, and the files API is then not installed: there is no path-based fallback.
 */
async function openStorageService(
  selection: OpenedArea,
  catalog: ResourceCatalog,
  sessionState: SessionStateOf | undefined,
  cleanup: StorageCleanupSetup | undefined,
): Promise<StorageService | null> {
  const { settings } = selection;
  if (settings.kind !== 'url') return null;
  const root = settings.location;
  try {
    const { openRootObjectStore } = await import('@agent-workspace/core/storage');
    const objects = await openRootObjectStore(root, openOptionsFor(root));
    const { createStorageService } = await import('../storage/service');
    if (cleanup !== undefined && sessionState !== undefined) {
      void startCleanupJob(objects, catalog, sessionState, cleanup).catch((error: unknown) => {
        log.error(
          `[compose] storage cleanup did not start (name=${safeProviderErrorName(error)}).`,
        );
      });
    }
    return createStorageService({
      catalog: (workspaceId) => catalog.forWorkspace(workspaceId),
      objects,
      ...(sessionState === undefined ? {} : { sessionState }),
      ...(cleanup?.audit === undefined ? {} : { audit: cleanup.audit }),
      log,
    });
  } catch (error) {
    log.error(storageReadinessFailure('storage', error));
    return null;
  }
}

const SIGNED_UPLOAD_MAX_BYTES_ENV = 'AW_STORAGE_SIGNED_UPLOAD_MAX_BYTES';

/**
 * The deployment's signed-upload size limit (the storage design, §04 "Size limits"). Unset or blank
 * means the contract's hard maximum; anything but a whole number from 1 to that maximum throws, so
 * start-up stops. The message names the variable and never echoes a value.
 */
function readSignedUploadMaxBytes(): number {
  const raw = configuredPath(SIGNED_UPLOAD_MAX_BYTES_ENV);
  if (raw === null) return SIGNED_UPLOAD_HARD_MAX_BYTES;
  const bytes = /^\d+$/.test(raw) ? Number(raw) : 0;
  if (bytes < 1 || bytes > SIGNED_UPLOAD_HARD_MAX_BYTES) {
    throw new Error(
      `${SIGNED_UPLOAD_MAX_BYTES_ENV} must be a whole number of bytes from 1 to ${SIGNED_UPLOAD_HARD_MAX_BYTES}.`,
    );
  }
  return bytes;
}

/** The session-state blob rows of a workspace, looked up through its scope. */
function sessionStateOf(
  scopes: DatabaseRoot['scopes'],
  sessionState: DatabaseRoot['sessionState'] | undefined,
): SessionStateOf | undefined {
  if (sessionState === undefined) return undefined;
  return async (workspaceId) => {
    const scope = await scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('the workspace of the session-state blob is gone');
    return sessionState.forScope(scope);
  };
}

/**
 * Build `/api/files*` (spec §16) over the workspace object store, for the root to install as
 * `ApplicationContext.files`. Every store refusal is logged by name and answers `unavailable`; a
 * malformed `AW_STORAGE_SIGNED_UPLOAD_MAX_BYTES` or `AW_STORAGE_CREATE_BUCKET` throws, so start-up
 * stops.
 */
export async function installFilesApi(
  { resolveWorkspace, scopes, catalog }: ApiWiring,
  fileTexts: DatabaseRoot['fileTexts'],
  sessionState?: DatabaseRoot['sessionState'],
  cleanup?: StorageCleanupWiring,
): Promise<Files> {
  const signedUploadMaxBytes = readSignedUploadMaxBytes();
  readCreateBucket();
  const cleanupMode = readStorageCleanupMode(configuredPath(STORAGE_CLEANUP_ENV));
  const selection = await openArea('files');
  if (selection.kind !== 'opened') {
    logAreaNotOpened('files', selection);
    return { kind: 'unavailable' };
  }
  try {
    const { createFileTextStoreProvider, createRepositoryObjectStoreProvider } =
      await import('../files/store');
    const storage = await openStorageService(
      selection,
      catalog,
      sessionStateOf(scopes, sessionState),
      cleanup === undefined ? undefined : { ...cleanup, mode: cleanupMode },
    );
    if (storage === null) {
      log.error(
        '[compose] files API NOT installed: the catalog service did not open. Every ' +
          '/api/files* route answers 503 files_runtime_not_configured.',
      );
      return { kind: 'unavailable' };
    }
    const runtime = {
      resolveWorkspace,
      store: createRepositoryObjectStoreProvider({ store: selection.store, scopes }),
      catalog,
      texts: createFileTextStoreProvider({ repositories: fileTexts, scopes }),
      signedUploadMaxBytes,
      storage,
    };
    log.info(
      `[compose] files API installed: ${describePlace(selection.location, 'files')} (spec §16)`,
    );
    return { kind: 'serving', runtime };
  } catch (error) {
    log.error(storageReadinessFailure('files', error));
    return { kind: 'unavailable' };
  }
}
