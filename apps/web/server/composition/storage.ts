import { SIGNED_UPLOAD_HARD_MAX_BYTES } from '@indx-workspace/contracts/files';
import type { StorageLocation } from '@indx-workspace/contracts/storage-url';
import { log } from '../telemetry/logger';
import type { DatabaseRoot } from '@agent-workspace/core/db';
import type {
  ObjectStoreProvider,
  ObjectStore,
  OpenObjectStoreOptions,
} from '@agent-workspace/core/storage';
import type { WorkspaceResolution } from '../agents/runtime';
import type { Files } from '../files/runtime';
import { createResourceCatalogStoreProvider } from '../resources/catalog-store';
import type { Skills } from '../skills/runtime';
import {
  readStorageCleanupMode,
  startStorageCleanup,
  STORAGE_CLEANUP_ENV,
} from '../storage/cleanup-cron';
import type { CleanupMode } from '../storage/cleanup-cron';
import type { CleanupDependencies } from '../storage/cleanup';
import type { SessionStateBlobCatalog, StorageService } from '../storage/service';
import type { MigrationRuns, WorkspaceSkillsStoreProvider } from '../storage/store';
import {
  configuredPath,
  resolveStorageSettings,
  STORAGE_URL_ENV,
  storageAreaPlace,
  type StorageArea,
  type StorageSettings,
} from './config';

type AreaSelection =
  | { readonly kind: 'unset' }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'failed'; readonly cause: unknown }
  | {
      readonly kind: 'opened';
      readonly store: ObjectStoreProvider;
      readonly location: StorageLocation;
      readonly settings: StorageSettings;
    };

const OBJECT_STORAGE_READINESS_TIMEOUT_MS = 10_000;

/** Keep provider URLs and credential-bearing messages out of deployment logs. */
export function storageReadinessFailure(resource: StorageArea | 'storage', cause: unknown): string {
  const errorName = safeProviderErrorName(cause);
  const statusCode = safeProviderStatusCode(cause);
  return `[compose] ${resource} API NOT installed: object storage failed readiness (name=${errorName}, status=${statusCode}).`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function safeProviderErrorName(cause: unknown): string {
  if (!isRecord(cause)) return 'UnknownProviderError';
  const name = cause['name'];
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name)
    ? name
    : 'UnknownProviderError';
}

function safeProviderStatusCode(cause: unknown): string {
  if (!isRecord(cause)) return 'unknown';
  const metadata = cause['$metadata'];
  if (!isRecord(metadata)) return 'unknown';
  const statusCode = metadata['httpStatusCode'];
  return typeof statusCode === 'number' &&
    Number.isInteger(statusCode) &&
    statusCode >= 100 &&
    statusCode <= 599
    ? String(statusCode)
    : 'unknown';
}

/** Credentials never travel in the location; they come from the environment or workload identity. */
function openOptionsFor(location: StorageLocation): OpenObjectStoreOptions {
  if (location.kind === 'azblob') {
    const managedIdentityClientId = configuredPath('AZURE_CLIENT_ID');
    return managedIdentityClientId === null ? {} : { managedIdentityClientId };
  }
  if (location.kind === 'gcs') return { timeoutMs: OBJECT_STORAGE_READINESS_TIMEOUT_MS };
  if (location.kind === 's3') {
    const accessKeyId = configuredPath('AWS_ACCESS_KEY_ID');
    const secretAccessKey = configuredPath('AWS_SECRET_ACCESS_KEY');
    // Temporary credentials are unusable without their token, which the explicit pair would drop.
    const sessionToken = configuredPath('AWS_SESSION_TOKEN');
    return {
      credentials: {
        ...(accessKeyId === null ? {} : { accessKeyId }),
        ...(secretAccessKey === null ? {} : { secretAccessKey }),
        ...(sessionToken === null ? {} : { sessionToken }),
      },
      createBucketIfMissing: readCreateBucket(),
    };
  }
  return {};
}

const CREATE_BUCKET_ENV = 'AW_STORAGE_CREATE_BUCKET';

/**
 * Whether the server provisions the bucket of an `s3://` `AW_STORAGE_URL` on first boot,
 * idempotently: the bundled SeaweedFS starts empty. A platform setting and never a URL parameter,
 * because customer storage connections share the URL parser and must never create a bucket. Unset
 * or blank is `false`; anything but `true` or `false` throws, so start-up stops. The message names
 * the variable and never echoes a value.
 */
function readCreateBucket(): boolean {
  const raw = configuredPath(CREATE_BUCKET_ENV);
  if (raw === null || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error(`${CREATE_BUCKET_ENV} must be true or false.`);
}

const warnedStorageSettings = new Set<string>();

function warnOnce(warning: string): void {
  if (warnedStorageSettings.has(warning)) return;
  warnedStorageSettings.add(warning);
  log.warn(`[compose] ${warning}`);
}

function describePlace(location: StorageLocation, area: StorageArea): string {
  if (location.kind === 'file') return `local filesystem object store rooted at ${location.root}`;
  const bucket = location.kind === 'azblob' ? location.container : location.bucket;
  const prefix = location.prefix === '' ? area : `${location.prefix}/${area}`;
  return `${location.kind} bucket ${bucket}, prefix ${prefix}/`;
}

/**
 * Open one area's store from `AW_STORAGE_URL`. The warning about leftover old variables is logged
 * once per process. `@agent-workspace/core/storage` resolves `types`
 * to `src/` and code to `dist/`, so core must be built before `apps/web` is checked.
 */
async function openArea(area: StorageArea): Promise<AreaSelection> {
  const settings = resolveStorageSettings();
  settings.warnings.forEach(warnOnce);
  const place = storageAreaPlace(settings, area);
  if (place.kind !== 'at') return place;
  if (place.location.kind !== 's3' && configuredPath(CREATE_BUCKET_ENV) !== null) {
    warnOnce(`${CREATE_BUCKET_ENV} applies only to an s3:// ${STORAGE_URL_ENV}, so it is ignored.`);
  }
  try {
    // The import stays dynamic so the composition module itself loads no cloud library.
    const { openObjectStore } = await import('@agent-workspace/core/storage');
    const store = await openObjectStore(place.location, area, openOptionsFor(place.location));
    return { kind: 'opened', store, location: place.location, settings };
  } catch (cause) {
    return { kind: 'failed', cause };
  }
}

/**
 * The catalog service over the `AW_STORAGE_URL` root. `null` when there is no shared root or it
 * cannot be opened, and the files API is then not installed: there is no path-based fallback.
 */
async function openStorageService(
  selection: Extract<AreaSelection, { kind: 'opened' }>,
  catalog: ReturnType<typeof createResourceCatalogStoreProvider>,
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

/** The session-state blob rows of a workspace: the service reads them, the cleanup checks them. */
type SessionStateOf = (
  workspaceId: string,
) => Promise<SessionStateBlobCatalog & Awaited<ReturnType<CleanupDependencies['sessionState']>>>;

/** What the cleanup job needs from the database root, and the mode read once at start-up. */
export interface StorageCleanupWiring {
  readonly lock: DatabaseRoot['withNamedLock'];
  readonly workspaceIds: DatabaseRoot['listWorkspaceIds'];
  /** The audit trail's sink; the storage service records file actions through it. */
  readonly audit?: DatabaseRoot['recordAuditEvent'];
  readonly stopOnClose: (stop: () => void) => void;
}

type StorageCleanupSetup = StorageCleanupWiring & { readonly mode: CleanupMode };

/**
 * Schedule the cleanup pass (the storage design, §04 "The cleanup job"): hourly in this process,
 * one pass at a time across servers.
 */
async function startCleanupJob(
  objects: ObjectStore,
  catalog: ReturnType<typeof createResourceCatalogStoreProvider>,
  sessionState: SessionStateOf,
  cleanup: StorageCleanupSetup,
): Promise<void> {
  const { runCleanupPass } = await import('../storage/cleanup');
  const driver = startStorageCleanup({
    cronSecret: configuredPath('CRON_SECRET'),
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

/** What the skills adopt pass needs from the database root. */
export interface SkillsAdoptWiring extends Pick<StorageCleanupWiring, 'lock' | 'workspaceIds'> {
  readonly migrationRuns: MigrationRuns;
  readonly owners: Pick<DatabaseRoot['workspaces'], 'ownerPrincipalId'>;
}

/**
 * The skills adopt pass (the storage design, §06), in the background and under its own database
 * lock. Off with `AW_STORAGE_MIGRATE=off`; this release has no other stage, so any other value runs
 * it, unless the latest recorded pass already proved no old skill form is left. Never rejects; a
 * failure is logged by name.
 */
// storage-bridge(#1699): old skill forms
async function startSkillsAdopt(
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

/**
 * Build `/api/files*` (spec §16) over the workspace object store, for the root to install as
 * `ApplicationContext.files`. Every store refusal is logged by name and answers `unavailable`; a
 * malformed `AW_STORAGE_SIGNED_UPLOAD_MAX_BYTES` or `AW_STORAGE_CREATE_BUCKET` throws, so start-up
 * stops.
 */
export async function installFilesApi(
  resolveWorkspace: (request: Request) => Promise<WorkspaceResolution>,
  scopes: DatabaseRoot['scopes'],
  catalog: ReturnType<typeof createResourceCatalogStoreProvider>,
  fileTexts: DatabaseRoot['fileTexts'],
  sessionState?: DatabaseRoot['sessionState'],
  cleanup?: StorageCleanupWiring,
): Promise<Files> {
  const signedUploadMaxBytes = readSignedUploadMaxBytes();
  readCreateBucket();
  const cleanupMode = readStorageCleanupMode(configuredPath(STORAGE_CLEANUP_ENV));
  const selection = await openArea('files');
  switch (selection.kind) {
    case 'refused':
      log.error(`[compose] files API NOT installed: ${selection.reason}`);
      return { kind: 'unavailable' };
    case 'failed':
      log.error(storageReadinessFailure('files', selection.cause));
      return { kind: 'unavailable' };
    case 'unset':
      log.error(
        `[compose] files API NOT installed: ${STORAGE_URL_ENV} is unset or blank, and this ` +
          `deployment will not invent a directory to keep a workspace's files in. Every ` +
          `/api/files* route answers 503 files_runtime_not_configured.`,
      );
      return { kind: 'unavailable' };
    case 'opened':
      try {
        const { createFileTextStoreProvider, createRepositoryObjectStoreProvider } =
          await import('../files/store');
        const storage = await openStorageService(
          selection,
          catalog,
          sessionState === undefined
            ? undefined
            : async (workspaceId) => {
                const scope = await scopes.forWorkspaceId(workspaceId);
                if (scope === null)
                  throw new Error('the workspace of the session-state blob is gone');
                return sessionState.forScope(scope);
              },
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
}

/**
 * Build `/api/skills*` (spec §7, W2-CP-04) over its own private object-store root, for the root to
 * install as `ApplicationContext.skills`. Every refusal is logged by name and answers `unavailable`.
 */
export async function installSkillsApi(
  resolveWorkspace: (request: Request) => Promise<WorkspaceResolution>,
  scopes: DatabaseRoot['scopes'],
  catalog: ReturnType<typeof createResourceCatalogStoreProvider>,
  storage?: StorageService,
  adopt?: SkillsAdoptWiring,
): Promise<Skills> {
  const selection = await openArea('skills');
  switch (selection.kind) {
    case 'refused':
      log.error(`[compose] skills API NOT installed: ${selection.reason}`);
      return { kind: 'unavailable' };
    case 'failed':
      log.error(storageReadinessFailure('skills', selection.cause));
      return { kind: 'unavailable' };
    case 'unset':
      log.error(
        `[compose] skills API NOT installed: ${STORAGE_URL_ENV} is unset or blank; every ` +
          `/api/skills* route answers 503 skills_runtime_not_configured.`,
      );
      return { kind: 'unavailable' };
    case 'opened':
      break;
  }
  try {
    const { createRepositorySkillsStoreProvider } = await import('../storage/store');
    const runtime = {
      resolveWorkspace,
      store: createRepositorySkillsStoreProvider({ store: selection.store, scopes }),
      catalog,
      ...(storage === undefined ? {} : { storage }),
    };
    log.info(`[compose] skills API installed: ${describePlace(selection.location, 'skills')}`);
    if (storage !== undefined && adopt !== undefined) {
      void startSkillsAdopt(runtime.store, catalog, storage, adopt);
    }
    return { kind: 'serving', runtime };
  } catch (error) {
    log.error(storageReadinessFailure('skills', error));
    return { kind: 'unavailable' };
  }
}
