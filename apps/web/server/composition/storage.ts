import { SIGNED_UPLOAD_HARD_MAX_BYTES } from '@indx-workspace/contracts/files';
import type { StorageLocation } from '@indx-workspace/contracts/storage-url';
import { log } from '../telemetry/logger';
import type { DatabaseRoot } from '@agent-workspace/core/db';
import type {
  ObjectStoreProviderV2,
  ObjectStoreV2,
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
import type { CopyDependencies } from '../storage/migrate-naming';
import type {
  FinalizeBlobCatalog,
  LegacyBlobCopier,
  MigrationRuns,
  WorkspaceSkillsStoreProvider,
} from '../storage/store';
import {
  configuredPath,
  legacyAreaPrefixes,
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
      readonly store: ObjectStoreProviderV2;
      readonly location: StorageLocation;
      readonly settings: StorageSettings;
    };

const OBJECT_STORAGE_READINESS_TIMEOUT_MS = 10_000;

/** Keep provider URLs and credential-bearing messages out of deployment logs. */
export function storageReadinessFailure(
  resource: 'files' | 'skills' | 'session-state' | 'storage',
  cause: unknown,
): string {
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
 * The catalog service over the `AW_STORAGE_URL` root (new object names) and the old area stores
 * (rows without an object id). `null` when there is no shared root or it cannot be opened, and the
 * files API is then not installed: there is no path-based fallback.
 */
async function openStorageService(
  selection: Extract<AreaSelection, { kind: 'opened' }>,
  catalog: ReturnType<typeof createResourceCatalogStoreProvider>,
  sessionState: SessionStateOf | undefined,
  cleanup: StorageCleanupSetup | undefined,
  copy: CopyJobSetup | null,
): Promise<StorageService | null> {
  const { settings } = selection;
  if (settings.kind !== 'url') return null;
  const root = settings.location;
  try {
    const { openRootObjectStore } = await import('@agent-workspace/core/storage');
    const objects = await openRootObjectStore(root, openOptionsFor(root));
    const skills = await openArea('skills');
    const stateBlobs = await openArea('session-state');
    const { createStorageService } = await import('../storage/service');
    if (cleanup !== undefined && sessionState !== undefined) {
      void startCleanupJob(selection, objects, catalog, sessionState, cleanup).catch(
        (error: unknown) => {
          log.error(
            `[compose] storage cleanup did not start (name=${safeProviderErrorName(error)}).`,
          );
        },
      );
    }
    const legacy = {
      files: selection.store,
      ...(skills.kind === 'opened' ? { skills: skills.store } : {}),
      ...(stateBlobs.kind === 'opened' ? { 'session-state': stateBlobs.store } : {}),
    };
    if (copy !== null) {
      void startCopyJob(copy, { objects, legacy, catalog, sessionState, cleanup }).catch(
        (error: unknown) => {
          log.error(
            `[compose] ${STORAGE_MIGRATE_ENV}=${copy.mode} stopped (name=${safeProviderErrorName(error)}).`,
          );
        },
      );
    }
    return createStorageService({
      catalog: (workspaceId) => catalog.forWorkspace(workspaceId),
      objects,
      legacy,
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
) => Promise<
  SessionStateBlobCatalog &
    Awaited<ReturnType<CleanupDependencies['sessionState']>> &
    LegacyBlobCopier &
    FinalizeBlobCatalog
>;

/** What the cleanup job needs from the database root, and the mode read once at start-up. */
export interface StorageCleanupWiring {
  readonly lock: DatabaseRoot['withNamedLock'];
  readonly workspaceIds: DatabaseRoot['listWorkspaceIds'];
  /** The verify passes of the old-naming migration (`AW_STORAGE_MIGRATE=finalize`). */
  readonly migrationRuns: MigrationRuns;
  /** The audit trail's sink; the storage service records file actions through it. */
  readonly audit?: DatabaseRoot['recordAuditEvent'];
  readonly stopOnClose: (stop: () => void) => void;
}

type StorageCleanupSetup = StorageCleanupWiring & { readonly mode: CleanupMode };

/**
 * Schedule the cleanup pass (the storage design, §04 "The cleanup job"): hourly in this process,
 * one pass at a time across servers. Legacy-naming objects are reported and never deleted.
 */
async function startCleanupJob(
  selection: Extract<AreaSelection, { kind: 'opened' }>,
  objects: ObjectStoreV2,
  catalog: ReturnType<typeof createResourceCatalogStoreProvider>,
  sessionState: SessionStateOf,
  cleanup: StorageCleanupSetup,
): Promise<void> {
  const { openRootObjectStore } = await import('@agent-workspace/core/storage');
  const { runCleanupPass } = await import('../storage/cleanup');
  // storage-bridge(#1699): the old files layout
  const old = legacyAreaPrefixes(selection.settings).find((entry) => entry.area === 'files');
  const legacy =
    old === undefined
      ? null
      : {
          objects: await openRootObjectStore(old.location, openOptionsFor(old.location)),
          prefix: old.prefix,
        };
  const driver = startStorageCleanup({
    cronSecret: configuredPath('CRON_SECRET'),
    stopOnClose: cleanup.stopOnClose,
    lock: cleanup.lock,
    log,
    pass: () =>
      runCleanupPass({
        objects,
        legacy,
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

/** What `AW_STORAGE_MIGRATE` asks for. */
type MigrateMode = 'off' | 'adopt' | 'copy' | 'copy-dry-run' | 'finalize';

/** `null` for a value that is none of the modes. Unset is `adopt`, the default. */
function readMigrateMode(raw: string | null): MigrateMode | null {
  if (raw === null) return 'adopt';
  return raw === 'off' ||
    raw === 'adopt' ||
    raw === 'copy' ||
    raw === 'copy-dry-run' ||
    raw === 'finalize'
    ? raw
    : null;
}

/** What the copy job needs beyond the stores: the mode, read once at start-up, and when to start. */
interface CopyJobSetup {
  readonly mode: 'copy' | 'copy-dry-run' | 'finalize';
  /** Settles when the adopt stage is done, so the copy sees every row adopt gives. */
  readonly after: Promise<void>;
}

/**
 * Run the copy stage (the storage design, §06), or for `finalize` the check-and-delete stage after
 * it, in this process, one run at a time across servers: it holds the database lock
 * `storage-migrate`, and a server that does not get it logs that and leaves the run to the holder.
 * Progress is logged by the stage itself.
 */
// storage-bridge(#1699): old object naming
async function startCopyJob(
  copy: CopyJobSetup,
  parts: {
    readonly objects: ObjectStoreV2;
    readonly legacy: CopyDependencies['legacy'];
    readonly catalog: ReturnType<typeof createResourceCatalogStoreProvider>;
    readonly sessionState: SessionStateOf | undefined;
    readonly cleanup: StorageCleanupSetup | undefined;
  },
): Promise<void> {
  const { cleanup } = parts;
  if (cleanup === undefined) {
    log.error(
      `[compose] ${STORAGE_MIGRATE_ENV}=${copy.mode} did not start: there is no database root to lock on.`,
    );
    return;
  }
  await copy.after;
  const { mode } = copy;
  if (mode === 'finalize') {
    const { runFinalizeStage } = await import('../storage/migrate-finalize');
    const finalized = await cleanup.lock('storage-migrate', () =>
      runFinalizeStage({
        objects: parts.objects,
        legacy: parts.legacy,
        catalog: (workspaceId) => parts.catalog.forWorkspace(workspaceId),
        ...(parts.sessionState === undefined ? {} : { blobs: parts.sessionState }),
        workspaceIds: cleanup.workspaceIds,
        runs: cleanup.migrationRuns,
        log,
      }),
    );
    if (!finalized.acquired) log.info('storage migration skipped: another server is running it');
    return;
  }
  const { runCopyStage } = await import('../storage/migrate-naming');
  const outcome = await cleanup.lock('storage-migrate', () =>
    runCopyStage({
      objects: parts.objects,
      legacy: parts.legacy,
      catalog: (workspaceId) => Promise.resolve(parts.catalog.forWorkspace(workspaceId)),
      ...(parts.sessionState === undefined ? {} : { blobs: parts.sessionState }),
      workspaceIds: cleanup.workspaceIds,
      mode,
      log,
    }),
  );
  if (!outcome.acquired) log.info('storage migration skipped: another server is running it');
}

/**
 * Unset or `AW_STORAGE_MIGRATE=adopt` gives every object the old naming left without a catalog row a
 * row, in the background (the storage design, §06). It is the default because lists and downloads
 * read the catalog, so a row-less upload would otherwise vanish from them; it is idempotent and
 * cheap once done. `copy` adopts first and then copies each old object to a new name (see
 * {@link startCopyJob}); `finalize` adopts, then checks every copy and deletes the old objects that
 * are accounted for; `copy-dry-run` only counts; `off` disables all of it. Never awaited:
 * requests and start-up do not wait for it, and a failure is logged by error name only. Any other
 * value is refused without echoing it. The promise settles when the adopt stage is done (or was not
 * asked for) and never rejects.
 */
// storage-bridge(#1699): old object naming
function startNamingMigration(
  selection: Extract<AreaSelection, { kind: 'opened' }>,
  catalog: ReturnType<typeof createResourceCatalogStoreProvider>,
  owners: Pick<DatabaseRoot['workspaces'], 'ownerPrincipalId'> | undefined,
  runs: MigrationRuns | undefined,
  mode: MigrateMode,
): Promise<void> {
  // A dry run writes nothing, so it does not adopt either.
  if (mode === 'off' || mode === 'copy-dry-run') return Promise.resolve();
  const legacy = legacyAreaPrefixes(selection.settings).find((entry) => entry.area === 'files');
  if (legacy === undefined || owners === undefined || runs === undefined) {
    // Unset means nothing was asked for: a deployment with no old layout has nothing to adopt.
    if (configuredPath(STORAGE_MIGRATE_ENV) !== null) {
      log.error(
        `[compose] ${STORAGE_MIGRATE_ENV}=${mode} did not adopt: there is no old files layout, owner lookup or run log.`,
      );
    }
    return Promise.resolve();
  }
  return (async () => {
    const { openRootObjectStore } = await import('@agent-workspace/core/storage');
    const objects = await openRootObjectStore(legacy.location, openOptionsFor(legacy.location));
    const { runAdoptStage } = await import('../storage/migrate-naming');
    await runAdoptStage({
      objects,
      prefix: legacy.prefix,
      catalog: (workspaceId) => catalog.forWorkspace(workspaceId),
      ownerPrincipalId: (workspaceId) => owners.ownerPrincipalId(workspaceId),
      runs,
      log,
    });
  })().catch((error: unknown) => {
    log.error(
      `[compose] ${STORAGE_MIGRATE_ENV}=${mode} stopped adopting (name=${safeProviderErrorName(error)}).`,
    );
  });
}

/** What the skills adopt pass needs from the database root. */
export interface SkillsAdoptWiring extends Pick<StorageCleanupWiring, 'lock' | 'workspaceIds'> {
  readonly migrationRuns: MigrationRuns;
  readonly owners: Pick<DatabaseRoot['workspaces'], 'ownerPrincipalId'>;
}

/**
 * The skills part of the adopt stage (the storage design, §06), in the background and under its own
 * database lock, so it never waits for the copy stage's. Off with `AW_STORAGE_MIGRATE=off`, and a
 * dry run writes nothing, so it does not adopt either. Never rejects; a failure is logged by name.
 */
// storage-bridge(#1699): old skill forms
async function startSkillsAdopt(
  store: WorkspaceSkillsStoreProvider,
  catalog: ReturnType<typeof createResourceCatalogStoreProvider>,
  storage: StorageService,
  adopt: SkillsAdoptWiring,
): Promise<void> {
  const mode = readMigrateMode(configuredPath(STORAGE_MIGRATE_ENV));
  if (mode === null || mode === 'off' || mode === 'copy-dry-run') return;
  try {
    const { runSkillsAdoptStage } = await import('../storage/migrate-skills');
    const ran = await adopt.lock('storage-migrate-skills', () =>
      runSkillsAdoptStage({
        workspaceIds: adopt.workspaceIds,
        objects: (workspaceId) => store.forWorkspace(workspaceId),
        catalog: (workspaceId) => Promise.resolve(catalog.forWorkspace(workspaceId)),
        ownerPrincipalId: (workspaceId) => adopt.owners.ownerPrincipalId(workspaceId),
        storage,
        runs: adopt.migrationRuns,
        log,
      }),
    );
    if (!ran.acquired) log.info('skills adopt skipped: another server is running it');
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
  owners?: Pick<DatabaseRoot['workspaces'], 'ownerPrincipalId'>,
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
        const migrateMode = readMigrateMode(configuredPath(STORAGE_MIGRATE_ENV));
        if (migrateMode === null) {
          log.error(
            `[compose] ${STORAGE_MIGRATE_ENV} must be adopt, copy, copy-dry-run, finalize or off; the old-naming migration did not start.`,
          );
        }
        // The copy waits for adopt, which starts once the storage service is up.
        let adopted: () => void = () => undefined;
        const afterAdopt = new Promise<void>((resolve) => {
          adopted = resolve;
        });
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
          migrateMode === 'copy' || migrateMode === 'copy-dry-run' || migrateMode === 'finalize'
            ? { mode: migrateMode, after: afterAdopt }
            : null,
        );
        void startNamingMigration(
          selection,
          catalog,
          owners,
          cleanup?.migrationRuns,
          migrateMode ?? 'off',
        ).then(adopted);
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

/**
 * The object store session-state **blobs** are written to, or `null` when this deployment has none.
 *
 * Its own prefix and its own root, never the files or skills store: a session-state blob is platform
 * bookkeeping about a conversation, and putting it inside `/api/files`' address space would make an
 * engine's internal state something a tenant can list, download and delete.
 *
 * `null` is a real answer, not a failure. Every *entry* is a database row and stays durable without
 * this, so a deployment with no object storage keeps working for every engine that has one — and the
 * two blob routes answer 503 naming the variable rather than pretending to have stored something
 * (ADR-0035).
 */
export async function sessionStateBlobStore(): Promise<ObjectStoreProviderV2 | null> {
  const selection = await openArea('session-state');
  switch (selection.kind) {
    case 'refused':
      log.error(`[compose] session-state blobs NOT installed: ${selection.reason}`);
      return null;
    case 'failed':
      log.error(storageReadinessFailure('session-state', selection.cause));
      return null;
    case 'unset':
      log.error(
        `[compose] session-state blobs NOT installed: ${STORAGE_URL_ENV} is unset or blank. ` +
          `Stream entries stay durable — ` +
          `they are database rows — and PUT/GET /api/sessions/:id/state-blobs answer 503 ` +
          `session_state_blobs_not_configured.`,
      );
      return null;
    case 'opened':
      log.info(
        `[compose] session-state blobs installed: ${describePlace(selection.location, 'session-state')}`,
      );
      return selection.store;
  }
}
