/**
 * Opening one storage area's object store from `AW_STORAGE_URL`: which provider options a location
 * needs, and the diagnostics that keep provider URLs and credentials out of deployment logs.
 */
import type { StorageLocation } from '@indx-workspace/contracts/storage-url';
import { log } from '../telemetry/logger';
import type { ObjectStoreProvider, OpenObjectStoreOptions } from '@agent-workspace/core/storage';
import {
  configuredPath,
  resolveStorageSettings,
  STORAGE_URL_ENV,
  storageAreaPlace,
  type StorageArea,
  type StorageSettings,
} from './config';

export type AreaSelection =
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

export function safeProviderErrorName(cause: unknown): string {
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
export function openOptionsFor(location: StorageLocation): OpenObjectStoreOptions {
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
export function readCreateBucket(): boolean {
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

export function describePlace(location: StorageLocation, area: StorageArea): string {
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
export async function openArea(area: StorageArea): Promise<AreaSelection> {
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

/** What to say when an area's API is left uninstalled because its store did not open. */
const UNSET_AREA_MESSAGES = {
  files:
    `[compose] files API NOT installed: ${STORAGE_URL_ENV} is unset or blank, and this ` +
    `deployment will not invent a directory to keep a workspace's files in. Every ` +
    `/api/files* route answers 503 files_runtime_not_configured.`,
  skills:
    `[compose] skills API NOT installed: ${STORAGE_URL_ENV} is unset or blank; every ` +
    `/api/skills* route answers 503 skills_runtime_not_configured.`,
} as const;

/** Log why `area`'s store did not open; the caller then answers `unavailable`. */
export function logAreaNotOpened(
  area: keyof typeof UNSET_AREA_MESSAGES,
  selection: Exclude<AreaSelection, { kind: 'opened' }>,
): void {
  switch (selection.kind) {
    case 'refused':
      log.error(`[compose] ${area} API NOT installed: ${selection.reason}`);
      return;
    case 'failed':
      log.error(storageReadinessFailure(area, selection.cause));
      return;
    case 'unset':
      log.error(UNSET_AREA_MESSAGES[area]);
      return;
  }
}
