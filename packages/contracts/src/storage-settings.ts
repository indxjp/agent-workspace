/**
 * Where a deployment keeps files, skills and session state, read from `AW_STORAGE_URL` alone (the
 * storage design, §03 and §04). One mapping for the server and the CLI, so `agent-workspace doctor`
 * reaches the same verdict, with the same words, as the server's start-up. The old location
 * variables are ignored, with one `storage_setting_ignored` warning that names them and never
 * their values. The exports the 0.6.10 release had for the old settings stay as `@deprecated`
 * shims until the next major release: they compile as before and the server ignores what they
 * describe. Pure, with no Node built-ins because contracts also ships to browsers.
 */
import { formatStorageUrl, parseStorageUrl, type StorageLocation } from './storage-url.js';

/** A non-empty, trimmed environment value, or `null`. */
export function configuredPath(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const trimmed = env[name]?.trim();
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
}

/** The one setting that says where files, skills and session state are kept (the storage design, §04). */
export const STORAGE_URL_ENV = 'AW_STORAGE_URL';

export type StorageArea = 'files' | 'skills' | 'session-state';

const STORAGE_AREAS: readonly StorageArea[] = ['files', 'skills', 'session-state'];

// storage-bridge(#1944): deprecated 0.6.10 storage-settings exports, removed in the next major release
/** @deprecated Deprecated in the release after 0.6.10; removed in the next major release (#1944). */
export const FILE_STORAGE_ROOT_ENV = 'AW_FILE_STORAGE_ROOT';

/** @deprecated Deprecated in the release after 0.6.10; removed in the next major release (#1944). */
export const SKILL_STORAGE_ROOT_ENV = 'AW_SKILL_STORAGE_ROOT';

/** @deprecated Deprecated in the release after 0.6.10; removed in the next major release (#1944). */
export const SESSION_STATE_STORAGE_ROOT_ENV = 'AW_SESSION_TRANSCRIPT_ROOT';

/** @deprecated Deprecated in the release after 0.6.10; removed in the next major release (#1944). */
export const OBJECT_STORAGE_BUCKET_ENV = 'OBJECT_STORAGE_BUCKET';

/** @deprecated Deprecated in the release after 0.6.10; removed in the next major release (#1944). */
export const OBJECT_STORAGE_BACKEND_ENV = 'OBJECT_STORAGE_BACKEND';

/** @deprecated Deprecated in the release after 0.6.10; removed in the next major release (#1944). */
export type ObjectStorageBackend = 's3' | 'gcs' | 'azure-blob';

/**
 * Reads `OBJECT_STORAGE_BACKEND` as 0.6.10 did; throws on a value it does not know.
 * @deprecated Deprecated in the release after 0.6.10; removed in the next major release (#1944).
 */
export function configuredObjectStorageBackend(
  env: Readonly<Record<string, string | undefined>>,
): ObjectStorageBackend | null {
  const raw = env[OBJECT_STORAGE_BACKEND_ENV]?.trim();
  if (raw === undefined || raw === '') return null;
  if (raw === 's3' || raw === 'gcs' || raw === 'azure-blob') return raw;
  throw new Error(`${OBJECT_STORAGE_BACKEND_ENV} must be s3, gcs, or azure-blob.`);
}

/** The old location variables: no longer read, and warned about while they are still set. */
export const IGNORED_STORAGE_VARIABLES: readonly string[] = [
  FILE_STORAGE_ROOT_ENV,
  SKILL_STORAGE_ROOT_ENV,
  SESSION_STATE_STORAGE_ROOT_ENV,
  OBJECT_STORAGE_BUCKET_ENV,
  OBJECT_STORAGE_BACKEND_ENV,
  'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_PUBLIC_ENDPOINT',
  'OBJECT_STORAGE_FORCE_PATH_STYLE',
];

type StorageEnv = Readonly<Record<string, string | undefined>>;

/** The old storage variables that are set, by name, in a stable order. */
export function ignoredStorageVariables(env: StorageEnv): string[] {
  return IGNORED_STORAGE_VARIABLES.filter((name) => configuredPath(name, env) !== null);
}

/**
 * The old storage variables that are set.
 * @deprecated Use `ignoredStorageVariables`. Deprecated in the release after 0.6.10; removed in the
 * next major release (#1944).
 */
export function legacyStorageVariables(env: StorageEnv): string[] {
  return ignoredStorageVariables(env);
}

/**
 * The one warning for the old variables `env` sets, or `null` when none is: it names them and
 * never a value. With `AW_STORAGE_URL` unset it also says that storage is off, because nothing is
 * read from the old location.
 */
export function ignoredStorageSettingsWarning(env: StorageEnv): string | null {
  const names = ignoredStorageVariables(env);
  if (names.length === 0) return null;
  const warning = `storage_setting_ignored: ignoring ${names.join(', ')}; ${STORAGE_URL_ENV} alone says where files, skills and session state are kept (see .env.example).`;
  return configuredPath(STORAGE_URL_ENV, env) === null
    ? `${warning} With ${STORAGE_URL_ENV} unset, nothing is read from the old location; files, skills and session state are off until ${STORAGE_URL_ENV} is set.`
    : warning;
}

/** @deprecated Deprecated in the release after 0.6.10; removed in the next major release (#1944). */
export type LegacyLocalRoots = {
  kind: 'local-roots';
  files: string | null;
  skills: string | null;
  sessionState: string | null;
  /** `OBJECT_STORAGE_BACKEND` without a bucket refuses files and skills, but not session state. */
  filesAndSkillsRefusal: string | null;
};

/** @deprecated Deprecated in the release after 0.6.10; removed in the next major release (#1944). */
export type ResolvePath = (path: string) => string;

/**
 * Where storage is kept. The `legacy` kind is deprecated and never produced: it stays in the type
 * until the next major release so that a `case 'legacy'` still compiles.
 */
// @story US-STO-10
export type StorageSettings =
  | { kind: 'url'; location: StorageLocation; warnings: readonly string[] }
  // Deprecated in the release after 0.6.10, never produced; removed in the next major release (#1944).
  | { kind: 'legacy'; location: StorageLocation | LegacyLocalRoots; warnings: readonly string[] }
  // `warnings` is optional on these two arms, as in 0.6.10, so a hand-built value still compiles.
  | { kind: 'none'; warnings?: readonly string[] }
  | { kind: 'refused'; reason: string; warnings?: readonly string[] };

/**
 * What `resolveStorageSettings` returns: `StorageSettings` with its warnings always set. The
 * `legacy` arm is never produced; it stays so that a `case 'legacy'` on the result still compiles.
 */
export type ResolvedStorageSettings =
  | Extract<StorageSettings, { kind: 'url' | 'legacy' }>
  | { kind: 'none'; warnings: readonly string[] }
  | { kind: 'refused'; reason: string; warnings: readonly string[] };

// storage-bridge(#1699): legacy per-area layout (incl. sessions/) until the naming migration
const FILE_AREA_DIRECTORY: Readonly<Record<StorageArea, string>> = {
  files: 'files',
  skills: 'skills',
  'session-state': 'sessions',
};

function areaLocation(location: StorageLocation, area: StorageArea): StorageLocation {
  return location.kind === 'file'
    ? { kind: 'file', root: `${location.root.replace(/\/+$/u, '')}/${FILE_AREA_DIRECTORY[area]}` }
    : location;
}

/** Where one area lives under the settings, as `openObjectStore(location, area)` expects it. */
export type StorageAreaPlace =
  | { kind: 'at'; location: StorageLocation }
  | { kind: 'unset' }
  | { kind: 'refused'; reason: string };

export function storageAreaPlace(settings: StorageSettings, area: StorageArea): StorageAreaPlace {
  if (settings.kind === 'refused') return { kind: 'refused', reason: settings.reason };
  if (settings.kind === 'none' || settings.kind === 'legacy') return { kind: 'unset' };
  return { kind: 'at', location: areaLocation(settings.location, area) };
}

/**
 * Where one area's objects sit in the old per-area naming: list `prefix` (no trailing slash) in
 * the store `location` opens as a root. Each key beneath it is `workspaces/<id>/<storage key>`.
 */
export type LegacyAreaPrefix = {
  readonly area: StorageArea;
  readonly location: StorageLocation;
  readonly prefix: string;
};

/**
 * The old object layouts a deployment may still hold (the storage design, §06 "Moving existing
 * files safely"): one entry per area. A bucket or a `file://` root keeps each area under its own
 * directory. Pure, so the server's adopt stage and `agent-workspace doctor` read one list.
 */
// storage-bridge(#1699): old object naming
export function legacyAreaPrefixes(settings: StorageSettings): readonly LegacyAreaPrefix[] {
  if (settings.kind === 'none' || settings.kind === 'refused' || settings.kind === 'legacy') {
    return [];
  }
  const { location } = settings;
  return STORAGE_AREAS.map((area) => ({
    area,
    location,
    prefix: `${location.kind === 'file' ? FILE_AREA_DIRECTORY[area] : area}/workspaces`,
  }));
}

const PUBLIC_URL_ENV = 'AW_PUBLIC_URL';

function httpOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The origins signed links may use; null for the cloud's own default, which is never the app's
 * origin. S3 signs virtual-hosted URLs (`<bucket>.<endpoint host>`) unless path style applies, so
 * both origins count whatever `forcePathStyle` says: the check errs towards refusing.
 */
function storageEndpointOrigins(location: StorageLocation): string[] | null {
  if (location.kind === 's3') {
    const endpoints = [location.endpoint, location.publicEndpoint].filter(
      (endpoint) => endpoint !== undefined,
    );
    if (endpoints.length === 0) return null;
    return endpoints.flatMap((endpoint) => {
      const url = URL.parse(endpoint);
      const virtualHosted =
        url === null ? null : httpOrigin(`${url.protocol}//${location.bucket}.${url.host}`);
      return [httpOrigin(endpoint), virtualHosted].filter((origin) => origin !== null);
    });
  }
  if (location.kind !== 'azblob') return null;
  if (location.serviceUrl === `https://${location.account}.blob.core.windows.net`) return null;
  const origin = httpOrigin(location.serviceUrl);
  return origin === null ? [] : [origin];
}

/**
 * Signed downloads must come from the storage domain, never the app's (the storage design, §05).
 * `URL.origin` lower-cases the host, punycodes it and drops the default port, so a proxy path on
 * the app's own origin compares equal. Without `AW_PUBLIC_URL` there is nothing to compare: warn.
 */
// @story US-STO-05
function guardStorageEndpoint(
  settings: Extract<ResolvedStorageSettings, { kind: 'url' }>,
  env: StorageEnv,
): Extract<ResolvedStorageSettings, { kind: 'url' | 'refused' }> {
  const origins = storageEndpointOrigins(settings.location);
  if (origins === null) return settings;
  const publicUrl = configuredPath(PUBLIC_URL_ENV, env);
  const publicOrigin = publicUrl === null ? null : httpOrigin(publicUrl);
  if (publicOrigin === null) {
    const warning = `${PUBLIC_URL_ENV} is not set to an http(s) URL, so the endpoint in ${STORAGE_URL_ENV} was not checked against the app's origin (the storage design, §05).`;
    return { ...settings, warnings: [...settings.warnings, warning] };
  }
  if (!origins.includes(publicOrigin)) return settings;
  return {
    kind: 'refused',
    warnings: settings.warnings,
    reason: `storage_endpoint_same_origin: the endpoint in ${STORAGE_URL_ENV} has the same origin as ${PUBLIC_URL_ENV}; signed downloads must not come from the app's domain (the storage design, §05).`,
  };
}

/**
 * Where this deployment keeps files, skills and session state (the storage design, §03 and §04).
 *
 * `AW_STORAGE_URL` is the only setting. The old location variables never name a place: while any
 * is set the result carries one `storage_setting_ignored` warning, and nothing else changes, so a
 * leftover variable never stops start-up. An invalid URL is `refused`, and so is an endpoint on
 * `AW_PUBLIC_URL`'s origin; a refusal still carries the ignored-variables warning. Every message
 * names variables and never repeats a value, because a value may be a secret.
 *
 * @param resolve - Deprecated in the release after 0.6.10; removed in the next major release
 * (#1944). Ignored: the server ignores the old storage settings it compared against.
 */
// @story US-STO-10
export function resolveStorageSettings(
  env: StorageEnv,
  resolve?: ResolvePath,
): ResolvedStorageSettings {
  void resolve;
  const ignored = ignoredStorageSettingsWarning(env);
  const warnings = ignored === null ? [] : [ignored];
  const rawUrl = configuredPath(STORAGE_URL_ENV, env);
  if (rawUrl === null) return { kind: 'none', warnings };

  const parsed = parseStorageUrl(rawUrl);
  if (!parsed.ok) {
    return {
      kind: 'refused',
      reason: `${STORAGE_URL_ENV} is invalid: ${parsed.reason}.`,
      warnings,
    };
  }
  const region = configuredPath('AWS_REGION', env);
  const location =
    parsed.location.kind === 's3' && parsed.location.region === undefined && region !== null
      ? { ...parsed.location, region }
      : parsed.location;
  return guardStorageEndpoint({ kind: 'url', location, warnings }, env);
}

/**
 * The `AW_STORAGE_URL` that names the same places as the old settings, or `null` when none can
 * (mixed local roots, or an Azure service URL with no account). Doctor prints it as the advice.
 * @deprecated Deprecated in the release after 0.6.10; removed in the next major release (#1944).
 */
// @story US-STO-10
export function storageUrlReplacing(
  location: StorageLocation | LegacyLocalRoots,
  env: StorageEnv,
): string | null {
  let url: StorageLocation | null;
  if (location.kind === 'local-roots') {
    const { files, skills, sessionState, filesAndSkillsRefusal } = location;
    const root = files?.endsWith('/files') === true ? files.slice(0, -'/files'.length) : null;
    const sharesRoot =
      filesAndSkillsRefusal === null &&
      root !== null &&
      skills === `${root}/${FILE_AREA_DIRECTORY.skills}` &&
      sessionState === `${root}/${FILE_AREA_DIRECTORY['session-state']}`;
    url = sharesRoot ? { kind: 'file', root } : null;
  } else if (location.kind === 'azblob' && location.account === '') {
    url = null;
  } else if (location.kind === 's3' && configuredPath('AWS_REGION', env) !== null) {
    const { kind, bucket, prefix, endpoint, publicEndpoint, forcePathStyle } = location;
    url = {
      kind,
      bucket,
      prefix,
      forcePathStyle,
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(publicEndpoint === undefined ? {} : { publicEndpoint }),
    };
  } else {
    url = location;
  }
  if (url === null) return null;
  const formatted = formatStorageUrl(url);
  return parseStorageUrl(formatted).ok ? formatted : null;
}
